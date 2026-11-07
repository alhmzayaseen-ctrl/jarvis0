import { randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
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

export const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskInput {
  title: string;
  description?: string | null;
  status: TaskStatus;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string | null;
}

export interface TaskRecord extends TaskInput {
  id: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEventInput {
  id?: string;
  taskId: string;
  eventType: string;
  content?: string | null;
  status?: TaskStatus;
  expectedStatus?: TaskStatus;
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  content: string | null;
  createdAt: string;
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

function assertNoSymbolicLinkComponents(rootDirectory: string, targetDirectory: string): void {
  let currentPath = rootDirectory;
  const components = relative(rootDirectory, targetDirectory).split(sep).filter(Boolean);
  for (const path of [rootDirectory, ...components.map((component) => (currentPath = join(currentPath, component)))]) {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error("Jarvis database path must not contain symbolic links.");
    }
  }
}

export class MemoryStore {
  private static sqlPromise?: Promise<SqlJsStatic>;

  private constructor(
    private readonly filePath: string,
    private readonly jarvisDirectory?: string,
  ) {}

  static async open(filePath: string): Promise<MemoryStore> {
    const jarvisDirectory = resolve(join(homedir(), ".jarvis"));
    const resolvedFilePath = resolve(filePath);
    const pathFromJarvisDirectory = relative(jarvisDirectory, resolvedFilePath);
    const isInsideJarvisDirectory =
      pathFromJarvisDirectory !== "" &&
      pathFromJarvisDirectory !== ".." &&
      !pathFromJarvisDirectory.startsWith(`..${sep}`);
    if (isInsideJarvisDirectory) {
      assertNoSymbolicLinkComponents(jarvisDirectory, dirname(resolvedFilePath));
    }
    mkdirSync(dirname(filePath), { recursive: true });
    if (isInsideJarvisDirectory) {
      assertNoSymbolicLinkComponents(jarvisDirectory, dirname(resolvedFilePath));
      const directoryStat = lstatSync(jarvisDirectory);
      if (!directoryStat.isDirectory()) throw new Error("Jarvis data directory must be a directory.");
      chmodSync(jarvisDirectory, 0o700);
    }
    if (existsSync(filePath)) {
      if (lstatSync(filePath).isSymbolicLink()) {
        throw new Error("SQLite database path must not be a symbolic link.");
      }
      chmodSync(filePath, 0o600);
    }
    const store = new MemoryStore(filePath, isInsideJarvisDirectory ? jarvisDirectory : undefined);
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

  async createTask(input: TaskInput): Promise<TaskRecord> {
    this.validateTaskInput(input);
    return this.withDatabase(true, (db) => {
      const now = new Date().toISOString();
      const task: TaskRecord = {
        id: randomUUID(),
        title: input.title,
        description: input.description ?? null,
        status: input.status,
        createdAt: now,
        updatedAt: now,
      };
      db.run(
        "INSERT INTO tasks (id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [task.id, task.title, task.description, task.status, task.createdAt, task.updatedAt],
      );
      return task;
    });
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    return this.withDatabase(false, (db) => this.selectTask(db, id));
  }

  async updateTask(id: string, input: TaskUpdateInput): Promise<TaskRecord> {
    if ("status" in input) {
      throw new Error("Use addTaskEvent to change task status.");
    }
    if (input.title === undefined && input.description === undefined) {
      throw new Error("At least one task field must be updated.");
    }
    if (input.title !== undefined) this.validateTaskTitle(input.title);

    return this.withDatabase(true, (db) => {
      const current = this.selectTask(db, id);
      if (!current) throw new Error("Task not found.");
      const updated: TaskRecord = {
        ...current,
        title: input.title ?? current.title,
        description: input.description === undefined ? current.description : input.description,
        updatedAt: new Date().toISOString(),
      };
      db.run(
        "UPDATE tasks SET title = ?, description = ?, updated_at = ? WHERE id = ?",
        [updated.title, updated.description, updated.updatedAt, id],
      );
      return updated;
    });
  }

  async addTaskEvent(input: TaskEventInput): Promise<TaskEventRecord> {
    if (!input.taskId.trim()) throw new Error("Task ID must not be empty.");
    if (!input.eventType.trim()) throw new Error("Task event type must not be empty.");
    if (input.status !== undefined) this.validateTaskStatus(input.status);
    if (input.expectedStatus !== undefined) this.validateTaskStatus(input.expectedStatus);

    return this.withDatabase(true, (db) => {
      const task = this.selectTask(db, input.taskId);
      if (!task) throw new Error("Task not found.");
      if (input.expectedStatus !== undefined && task.status !== input.expectedStatus) {
        throw new Error(
          `Task status changed: expected ${input.expectedStatus}, found ${task.status}.`,
        );
      }
      const now = new Date().toISOString();
      const event: TaskEventRecord = {
        id: input.id ?? randomUUID(),
        taskId: input.taskId,
        eventType: input.eventType,
        content: input.content ?? null,
        createdAt: now,
      };
      const sequenceStatement = db.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events",
      );
      let sequence: number;
      try {
        sequenceStatement.step();
        sequence = Number(sequenceStatement.getAsObject().sequence);
      } finally {
        sequenceStatement.free();
      }
      db.run(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
        [input.status ?? task.status, now, task.id],
      );
      db.run(
        "INSERT INTO task_events (sequence, id, task_id, event_type, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [sequence, event.id, event.taskId, event.eventType, event.content, event.createdAt],
      );
      return event;
    });
  }

  async listTaskEvents(taskId: string): Promise<TaskEventRecord[]> {
    return this.withDatabase(false, (db) => {
      const statement = db.prepare(
        "SELECT id, task_id, event_type, content, created_at FROM task_events WHERE task_id = ? ORDER BY sequence ASC",
      );
      statement.bind([taskId]);
      const events: TaskEventRecord[] = [];
      try {
        while (statement.step()) events.push(this.toTaskEvent(statement.getAsObject()));
      } finally {
        statement.free();
      }
      return events;
    });
  }

  private validateTaskInput(input: TaskInput): void {
    this.validateTaskTitle(input.title);
    this.validateTaskStatus(input.status);
  }

  private validateTaskTitle(title: string): void {
    if (!title.trim()) throw new Error("Task title must not be empty.");
  }

  private validateTaskStatus(status: TaskStatus): void {
    if (!TASK_STATUSES.includes(status)) throw new Error("Unsupported task status.");
  }

  private validate(input: MemoryInput): void {
    if (!MEMORY_KINDS.includes(input.kind)) throw new Error(`Unsupported memory kind: ${input.kind}`);
    for (const field of ["key", "value", "provenance"] as const) {
      if (!input[field].trim()) throw new Error(`${field} must not be empty`);
    }
  }

  private async withDatabase<T>(write: boolean, action: (db: Database) => T): Promise<T> {
    this.assertJarvisPathSafe();
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
        this.assertJarvisPathSafe();
        writeFileSync(tempPath, bytes, { mode: 0o600 });
        chmodSync(tempPath, 0o600);
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
    this.assertJarvisPathSafe();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        const token = randomUUID();
        try {
          fchmodSync(fd, 0o600);
          writeFileSync(fd, JSON.stringify({ createdAt: Date.now(), pid: process.pid, token }));
          return { fd, token };
        } catch (error) {
          try {
            closeSync(fd);
          } catch {
            // Preserve the original lock setup error.
          }
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore cleanup failure and preserve the original lock setup error.
          }
          throw error;
        }
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

  private assertJarvisPathSafe(): void {
    if (!this.jarvisDirectory) return;
    assertNoSymbolicLinkComponents(this.jarvisDirectory, dirname(resolve(this.filePath)));
    if (existsSync(this.filePath) && lstatSync(this.filePath).isSymbolicLink()) {
      throw new Error("SQLite database path must not be a symbolic link.");
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
    db.run("PRAGMA foreign_keys = ON;");
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
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        event_type TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureTaskEventSequence(db);
  }

  private ensureTaskEventSequence(db: Database): void {
    const columns = db.prepare("PRAGMA table_info(task_events)");
    let hasSequence = false;
    try {
      while (columns.step()) {
        if (columns.getAsObject().name === "sequence") hasSequence = true;
      }
    } finally {
      columns.free();
    }

    if (!hasSequence) {
      db.run("ALTER TABLE task_events ADD COLUMN sequence INTEGER");
      const events = db.prepare("SELECT id FROM task_events ORDER BY rowid ASC");
      const ids: string[] = [];
      try {
        while (events.step()) ids.push(String(events.getAsObject().id));
      } finally {
        events.free();
      }
      const update = db.prepare("UPDATE task_events SET sequence = ? WHERE id = ?");
      try {
        ids.forEach((id, index) => update.run([index + 1, id]));
      } finally {
        update.free();
      }
    }

    db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS task_events_sequence_unique ON task_events(sequence)",
    );
  }

  private selectRecord(db: Database, key: string): MemoryRecord | null {
    const statement = db.prepare("SELECT * FROM memories WHERE key = ?");
    statement.bind([key]);
    const result = statement.step() ? this.toRecord(statement.getAsObject()) : null;
    statement.free();
    return result;
  }

  private selectTask(db: Database, id: string): TaskRecord | null {
    const statement = db.prepare("SELECT * FROM tasks WHERE id = ?");
    statement.bind([id]);
    try {
      return statement.step() ? this.toTask(statement.getAsObject()) : null;
    } finally {
      statement.free();
    }
  }

  private toTask(row: Record<string, unknown>): TaskRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      description: row.description === null ? null : String(row.description),
      status: String(row.status) as TaskStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toTaskEvent(row: Record<string, unknown>): TaskEventRecord {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      eventType: String(row.event_type),
      content: row.content === null ? null : String(row.content),
      createdAt: String(row.created_at),
    };
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
