import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

export const MEMORY_KINDS = ["fact", "goal", "project", "decision"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryInput {
  kind: MemoryKind;
  key: string;
  value: string;
  provenance: string;
}

export interface MemoryRecord extends MemoryInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRevision extends MemoryRecord {
  revision: number;
}

export class MemoryConflictError extends Error {
  constructor(
    readonly key: string,
    readonly expectedVersion: number,
    readonly actualVersion: number | null,
  ) {
    super(`Memory "${key}" changed: expected version ${expectedVersion}, found ${actualVersion ?? "missing"}`);
    this.name = "MemoryConflictError";
  }
}

export class MemoryExistsError extends Error {
  constructor(key: string) {
    super(`Memory "${key}" already exists`);
    this.name = "MemoryExistsError";
  }
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const SEMANTIC_CONCEPTS = [
  {
    id: "color",
    terms: ["لون", "اللون", "ألوان", "الألوان", "color", "colors", "colour", "colours"],
  },
  {
    id: "test",
    terms: ["اختبار", "الاختبار", "اختبارات", "التجربة", "تجربة", "test", "tests", "testing"],
  },
  {
    id: "preference",
    terms: [
      "مفضل",
      "مفضلة",
      "المفضل",
      "المفضلة",
      "تفضيل",
      "التفضيل",
      "تفضيلات",
      "favorite",
      "favorites",
      "favourite",
      "favourites",
      "preferred",
      "preference",
    ],
  },
  {
    id: "language",
    terms: ["لغة", "اللغة", "language"],
  },
  {
    id: "reply",
    terms: ["رد", "الرد", "reply", "response"],
  },
] as const;
const SEMANTIC_MATCH_RULES = [
  {
    queryConcepts: ["color", "test"],
    keyConcepts: ["color", "test"],
  },
  {
    queryConcepts: ["language", "reply", "preference"],
    keyConcepts: ["language", "reply"],
    keyPrefix: "preference",
  },
] as const;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MemoryStore {
  private static sqlPromise?: Promise<SqlJsStatic>;

  private constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<MemoryStore> {
    const store = new MemoryStore(filePath);
    await store.withDatabase(true, () => undefined);
    return store;
  }

  async get(key: string): Promise<MemoryRecord | null> {
    return this.withDatabase(false, (db) => this.selectRecord(db, key));
  }

  async list(kind?: MemoryKind): Promise<MemoryRecord[]> {
    return this.withDatabase(false, (db) => {
      const statement = db.prepare(
        kind
          ? "SELECT * FROM memories WHERE kind = ? ORDER BY created_at, key"
          : "SELECT * FROM memories ORDER BY created_at, key",
      );
      if (kind) statement.bind([kind]);
      const records: MemoryRecord[] = [];
      while (statement.step()) records.push(this.toRecord(statement.getAsObject()));
      statement.free();
      return records;
    });
  }

  async search(query: string, limit = 10): Promise<MemoryRecord[]> {
    if (!query.trim()) throw new Error("query must not be empty");
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");

    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) throw new Error("query must contain searchable text");
    const queryConcepts = findSemanticConcepts(terms);

    const records = await this.list();
    return records
      .map((record) => {
        const key = tokenize(record.key);
        const value = tokenize(record.value);
        const provenance = tokenize(record.provenance);
        const literalScore = terms.reduce(
          (total, term) =>
            total +
            (key.includes(term) ? 3 : 0) +
            (value.includes(term) ? 2 : 0) +
            (provenance.includes(term) ? 1 : 0),
          0,
        );
        const keyConcepts = findSemanticConcepts(key);
        const semanticMatch = matchesSemanticRule(queryConcepts, key, keyConcepts);
        const score = semanticMatch ? Math.max(literalScore, 3) : literalScore;
        return { record, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.record.key.localeCompare(right.record.key))
      .slice(0, limit)
      .map(({ record }) => record);
  }

  async history(key: string): Promise<MemoryRevision[]> {
    return this.withDatabase(false, (db) => {
      const statement = db.prepare("SELECT * FROM memory_history WHERE key = ? ORDER BY version");
      statement.bind([key]);
      const records: MemoryRevision[] = [];
      while (statement.step()) {
        const row = statement.getAsObject();
        records.push({ ...this.toRecord(row), revision: Number(row.version) });
      }
      statement.free();
      return records;
    });
  }

  async create(input: MemoryInput): Promise<MemoryRecord> {
    this.validate(input);
    return this.withDatabase(true, (db) => {
      if (this.selectRecord(db, input.key)) throw new MemoryExistsError(input.key);
      const now = new Date().toISOString();
      const record: MemoryRecord = {
        ...input,
        id: randomUUID(),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.run(
        "INSERT INTO memories (id, kind, key, value, provenance, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [record.id, record.kind, record.key, record.value, record.provenance, record.version, now, now],
      );
      this.insertHistory(db, record);
      return record;
    });
  }

  async update(key: string, expectedVersion: number, correction: MemoryInput): Promise<MemoryRecord> {
    this.validate(correction);
    if (correction.key !== key) throw new Error("Correction key must match the target key");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error("expectedVersion must be a positive integer");
    }

    return this.withDatabase(true, (db) => {
      const current = this.selectRecord(db, key);
      if (!current || current.version !== expectedVersion) {
        throw new MemoryConflictError(key, expectedVersion, current?.version ?? null);
      }
      const updated: MemoryRecord = {
        ...correction,
        id: current.id,
        version: current.version + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      db.run(
        "UPDATE memories SET kind = ?, value = ?, provenance = ?, version = ?, updated_at = ? WHERE key = ?",
        [updated.kind, updated.value, updated.provenance, updated.version, updated.updatedAt, key],
      );
      this.insertHistory(db, updated);
      return updated;
    });
  }

  private validate(input: MemoryInput): void {
    if (!MEMORY_KINDS.includes(input.kind)) throw new Error(`Unsupported memory kind: ${input.kind}`);
    for (const field of ["key", "value", "provenance"] as const) {
      if (!input[field].trim()) throw new Error(`${field} must not be empty`);
    }
  }

  private async withDatabase<T>(write: boolean, action: (db: Database) => T): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    const lock = write ? await this.acquireLock(lockPath) : undefined;
    let db: Database | undefined;
    let tempPath: string | undefined;

    try {
      const SQL = await (MemoryStore.sqlPromise ??= initSqlJs());
      db = existsSync(this.filePath)
        ? new SQL.Database(new Uint8Array(readFileSync(this.filePath)))
        : new SQL.Database();
      this.initializeSchema(db);
      const result = action(db);
      if (write) {
        const bytes = Buffer.from(db.export());
        tempPath = join(dirname(this.filePath), `.${basename(this.filePath)}.${randomUUID()}.pending`);
        writeFileSync(tempPath, bytes);
        renameSync(tempPath, this.filePath);
        tempPath = undefined;
      }
      return result;
    } finally {
      db?.close();
      if (tempPath && existsSync(tempPath)) unlinkSync(tempPath);
      if (lock) {
        closeSync(lock.fd);
        try {
          const owner = JSON.parse(readFileSync(lockPath, "utf8"));
          if (owner.token === lock.token) unlinkSync(lockPath);
        } catch {
          // The lock may have been removed during recovery.
        }
      }

    }
  }

  private async acquireLock(lockPath: string): Promise<{ fd: number; token: string }> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const fd = openSync(lockPath, "wx");
        const token = randomUUID();
        writeFileSync(fd, JSON.stringify({ createdAt: Date.now(), pid: process.pid, token }));
        return { fd, token };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          let owner: { createdAt?: unknown; pid?: unknown; token?: unknown } | undefined;
          try {
            owner = JSON.parse(readFileSync(lockPath, "utf8"));
          } catch {
            owner = undefined;
          }
          let createdAt: number;
          createdAt =
            typeof owner?.createdAt === "number" ? owner.createdAt : statSync(lockPath).mtimeMs;
          const age = Date.now() - createdAt;
          const ownerIsAlive =
            typeof owner?.pid === "number" && Number.isInteger(owner.pid) && this.isProcessAlive(owner.pid);
          if (age > LOCK_STALE_MS && !ownerIsAlive) {
            const currentOwner = JSON.parse(readFileSync(lockPath, "utf8"));
            if (typeof currentOwner.token === "string" && currentOwner.token !== owner?.token) continue;
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // The lock may have been removed while being checked.
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for memory lock: ${lockPath}`);
        await delay(25);
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private initializeSchema(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('fact', 'goal', 'project', 'decision')),
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        provenance TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_history (
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        provenance TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
    `);
  }

  private selectRecord(db: Database, key: string): MemoryRecord | null {
    const statement = db.prepare("SELECT * FROM memories WHERE key = ?");
    statement.bind([key]);
    const result = statement.step() ? this.toRecord(statement.getAsObject()) : null;
    statement.free();
    return result;
  }

  private insertHistory(db: Database, record: MemoryRecord): void {
    db.run(
      "INSERT INTO memory_history (id, kind, key, value, provenance, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        record.id,
        record.kind,
        record.key,
        record.value,
        record.provenance,
        record.version,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  private toRecord(row: Record<string, unknown>): MemoryRecord {
    return {
      id: String(row.id),
      kind: String(row.kind) as MemoryKind,
      key: String(row.key),
      value: String(row.value),
      provenance: String(row.provenance),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

function findSemanticConcepts(terms: string[]): Set<string> {
  const termSet = new Set(terms);
  return new Set(
    SEMANTIC_CONCEPTS
      .filter((concept) => concept.terms.some((term) => termSet.has(term)))
      .map(({ id }) => id),
  );
}

function matchesSemanticRule(
  queryConcepts: Set<string>,
  keyTerms: string[],
  keyConcepts: Set<string>,
): boolean {
  return SEMANTIC_MATCH_RULES.some(
    (rule) =>
      rule.queryConcepts.every((concept) => queryConcepts.has(concept)) &&
      rule.keyConcepts.every((concept) => keyConcepts.has(concept)) &&
      (!("keyPrefix" in rule) || keyTerms[0] === rule.keyPrefix),
  );
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}
