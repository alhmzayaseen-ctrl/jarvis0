import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { containsSensitiveContent } from "./privacy";
import {
  OllamaEmbeddingProvider,
  type EmbeddingProvider,
} from "./embedding";
import { buildEmbeddingModelIdentity } from "./embedding_identity";

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

export const EMBEDDING_HASH_VERSION = "v1";

/**
 * Normalizes text for embedding input hashing according to the immutable v1 specification:
 * 1. Normalizes CRLF / CR line endings to LF (\n)
 * 2. Trims leading and trailing whitespace
 * 3. Applies Unicode NFC canonical normalization
 *
 * Any future change to normalization semantics requires a new version prefix (e.g., v2:)
 * and an explicit reindexing migration.
 */
export function normalizeEmbeddingInput(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().normalize("NFC");
}

export function computeEmbeddingInputHash(value: string): string {
  const normalized = normalizeEmbeddingInput(value);
  return createHash("sha256")
    .update(`${EMBEDDING_HASH_VERSION}:${normalized}`, "utf8")
    .digest("hex");
}

export function serializeEmbedding(vector: Float32Array): Buffer {
  if (!(vector instanceof Float32Array) || vector.length === 0) {
    throw new Error("Embedding vector must be a non-empty Float32Array.");
  }
  const buffer = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    if (!Number.isFinite(value)) {
      throw new Error(`Embedding vector contains non-finite value at index ${i}.`);
    }
    view.setFloat32(i * 4, value, true);
  }
  return Buffer.from(buffer);
}

export function deserializeEmbedding(
  bytes: Uint8Array,
  expectedDimensions = 1024,
): Float32Array {
  if (!Number.isInteger(expectedDimensions) || expectedDimensions < 1) {
    throw new Error("expectedDimensions must be a positive integer.");
  }
  const expectedByteLength = expectedDimensions * 4;
  if (bytes.byteLength !== expectedByteLength) {
    throw new Error(
      `Invalid embedding BLOB size: expected ${expectedByteLength} bytes for ${expectedDimensions} dimensions, got ${bytes.byteLength} bytes.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(expectedDimensions);
  for (let i = 0; i < expectedDimensions; i++) {
    const value = view.getFloat32(i * 4, true);
    if (!Number.isFinite(value)) {
      throw new Error(`Deserialized embedding contains non-finite value at index ${i}.`);
    }
    vector[i] = value;
  }
  return vector;
}

export function assertForeignKeysEnabled(db: Database): void {
  const fkResult = db.exec("PRAGMA foreign_keys;");
  const isEnabled = fkResult?.[0]?.values?.[0]?.[0] === 1;
  if (!isEnabled) {
    throw new Error(
      "SQLite foreign keys enforcement failed: PRAGMA foreign_keys is not enabled (expected 1).",
    );
  }
}

export interface MemoryEmbeddingInput {
  memoryId: string;
  model: string;
  dimensions: number;
  contentHash: string;
  vector: Float32Array;
  indexedAt?: string;
}

export const MAX_EMBEDDING_BATCH_SIZE = 50;

export interface PendingEmbeddingRecord {
  id: string;
  value: string;
  valueHash: string;
}

export interface PreparedEmbeddingItem {
  memoryId: string;
  dimensions: number;
  contentHash: string;
  vector: Float32Array;
  indexedAt?: string;
}

export interface SaveEmbeddingsBatchResult {
  written: number;
  skippedDeleted: number;
  skippedStale: number;
}

export interface EmbeddingStats {
  databaseExists: boolean;
  activeModel: string;
  totalMemories: number;
  indexedValid: number;
  staleMismatched: number;
  unindexed: number;
  pendingTotal: number;
  otherModels: Array<{ model: string; count: number }>;
}

export const UPSERT_MEMORY_EMBEDDING_SQL = `
  INSERT INTO memory_embeddings (memory_id, model, dimensions, content_hash, vector, indexed_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(memory_id, model) DO UPDATE SET
    dimensions = excluded.dimensions,
    content_hash = excluded.content_hash,
    vector = excluded.vector,
    indexed_at = excluded.indexed_at
`;

export function upsertMemoryEmbedding(db: Database, input: MemoryEmbeddingInput): void {
  if (!input.memoryId.trim()) throw new Error("memoryId must not be empty.");
  if (!input.model.trim()) throw new Error("model must not be empty.");
  if (!Number.isInteger(input.dimensions) || input.dimensions < 1) {
    throw new Error("dimensions must be a positive integer.");
  }
  if (!input.contentHash.trim()) throw new Error("contentHash must not be empty.");
  if (input.vector.length !== input.dimensions) {
    throw new Error(
      `Vector length (${input.vector.length}) does not match dimensions (${input.dimensions}).`,
    );
  }
  const vectorBlob = serializeEmbedding(input.vector);
  const indexedAt = input.indexedAt ?? new Date().toISOString();
  db.run(UPSERT_MEMORY_EMBEDDING_SQL, [
    input.memoryId,
    input.model,
    input.dimensions,
    input.contentHash,
    vectorBlob,
    indexedAt,
  ]);
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const INCOMPLETE_LOCK_STALE_MS = 500;
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

function tryLstatSync(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertDatabaseFileNotSymlink(filePath: string): Stats | null {
  const stat = tryLstatSync(filePath);
  if (stat?.isSymbolicLink()) {
    throw new Error("SQLite database path must not be a symbolic link.");
  }
  return stat;
}

interface LockHandle {
  token: string;
  ino: number;
  createdAt: number;
  pid: number;
}

interface EvictLockHandle extends LockHandle {
  entryPath: string;
}

type LockInspection =
  | { status: "missing" }
  | {
      status: "incomplete";
      ino: number;
      ageMs: number;
    }
  | {
      status: "valid";
      ino: number;
      createdAt: number;
      pid: number;
      token: string;
      ageMs: number;
    };

export interface MemoryStoreOptions {
  embeddingProvider?: EmbeddingProvider;
  modelIdentity?: string;
  searchEmbedTimeoutMs?: number;
}

export function resolveMemoryEmbeddingModelIdentity(
  provider: Pick<EmbeddingProvider, "modelName" | "dimensions">,
  options?: {
    providerName?: string;
    hashVersion?: string;
    digest?: string;
    extra?: Record<string, string>;
  },
): string {
  const providerName =
    options?.providerName ??
    (provider instanceof OllamaEmbeddingProvider ? "ollama" : "custom");
  const digest =
    options?.digest !== undefined
      ? options.digest
      : process.env.JARVIS_EMBEDDING_DIGEST;

  return buildEmbeddingModelIdentity({
    provider: providerName,
    modelName: provider.modelName,
    dimensions: provider.dimensions,
    hashVersion: options?.hashVersion ?? EMBEDDING_HASH_VERSION,
    digest,
    extra: options?.extra,
  }).identity;
}

export class MemoryStore {
  private static sqlPromise?: Promise<SqlJsStatic>;
  private static readonly incompleteFirstSeenByIno = new Map<string, number>();
  private static readonly validFirstSeenByIno = new Map<string, number>();

  private state: "open" | "closing" | "closed" = "open";
  private embeddingProvider?: EmbeddingProvider;
  private readonly modelIdentity?: string;
  private readonly searchEmbedTimeoutMs: number;
  private readonly abortController = new AbortController();
  private readonly backgroundQueue: Array<() => Promise<void>> = [];
  private runningTasks = 0;
  private readonly maxConcurrency = 2;
  private readonly activeTaskPromises = new Set<Promise<void>>();
  private activeBackgroundWrites = 0;
  private writeCompletionResolvers: Array<() => void> = [];
  private idleResolvers: Array<() => void> = [];
  private closePromise?: Promise<void>;

  private constructor(
    private readonly filePath: string,
    private readonly jarvisDirectory?: string,
    private readonly readOnly = false,
    embeddingProvider?: EmbeddingProvider,
    modelIdentity?: string,
    searchEmbedTimeoutMs = 2000,
  ) {
    this.embeddingProvider = embeddingProvider;
    this.modelIdentity = modelIdentity;
    this.searchEmbedTimeoutMs = searchEmbedTimeoutMs;
  }

  getModelIdentity(): string | undefined {
    if (this.modelIdentity) {
      return this.modelIdentity;
    }
    if (this.embeddingProvider) {
      if (this.embeddingProvider instanceof OllamaEmbeddingProvider) {
        return resolveMemoryEmbeddingModelIdentity(this.embeddingProvider);
      }
      return this.embeddingProvider.modelName;
    }
    return undefined;
  }

  static async open(filePath: string, options?: MemoryStoreOptions): Promise<MemoryStore> {
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
    const fileStat = assertDatabaseFileNotSymlink(filePath);
    if (fileStat) {
      chmodSync(filePath, 0o600);
    }
    const store = new MemoryStore(
      filePath,
      isInsideJarvisDirectory ? jarvisDirectory : undefined,
      false,
      options?.embeddingProvider,
      options?.modelIdentity,
      options?.searchEmbedTimeoutMs,
    );
    await store.withDatabase(true, () => undefined);
    return store;
  }

  static async openReadOnly(filePath: string, options?: MemoryStoreOptions): Promise<MemoryStore> {
    const jarvisDirectory = resolve(join(homedir(), ".jarvis"));
    const resolvedFilePath = resolve(filePath);
    const pathFromJarvisDirectory = relative(jarvisDirectory, resolvedFilePath);
    const isInsideJarvisDirectory =
      pathFromJarvisDirectory !== "" &&
      pathFromJarvisDirectory !== ".." &&
      !pathFromJarvisDirectory.startsWith(`..${sep}`);
    if (isInsideJarvisDirectory) {
      assertNoSymbolicLinkComponents(jarvisDirectory, dirname(resolvedFilePath));
      const jarvisDirStat = tryLstatSync(jarvisDirectory);
      if (jarvisDirStat && !jarvisDirStat.isDirectory()) {
        throw new Error("Jarvis data directory must be a directory.");
      }
    }
    assertDatabaseFileNotSymlink(filePath);
    return new MemoryStore(
      filePath,
      isInsideJarvisDirectory ? jarvisDirectory : undefined,
      true,
      options?.embeddingProvider,
      options?.modelIdentity,
      options?.searchEmbedTimeoutMs,
    );
  }

  async get(key: string): Promise<MemoryRecord | null> {
    if (this.readOnly && tryLstatSync(this.filePath) === null) {
      return null;
    }
    return this.withDatabase(false, (db) => {
      if (this.readOnly && !this.hasTable(db, "memories")) {
        return null;
      }
      return this.selectRecord(db, key);
    });
  }

  async list(kind?: MemoryKind): Promise<MemoryRecord[]> {
    if (this.readOnly && tryLstatSync(this.filePath) === null) {
      return [];
    }
    return this.withDatabase(false, (db) => {
      if (this.readOnly && !this.hasTable(db, "memories")) {
        return [];
      }
      const statement = db.prepare(
        kind
          ? "SELECT * FROM memories WHERE kind = ? ORDER BY created_at, key"
          : "SELECT * FROM memories ORDER BY created_at, key",
      );
      try {
        if (kind) statement.bind([kind]);
        const records: MemoryRecord[] = [];
        while (statement.step()) records.push(this.toRecord(statement.getAsObject()));
        return records;
      } finally {
        statement.free();
      }
    });
  }

  async search(query: string, limit = 10): Promise<MemoryRecord[]> {
    if (!query.trim()) throw new Error("query must not be empty");
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");

    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) throw new Error("query must contain searchable text");
    const queryConcepts = findSemanticConcepts(terms);

    const candidateLimit = Math.min(Math.max(limit * 10, 50), 200);

    // 1. Lexical candidate gathering
    const records = await this.list();
    const scoredLexical = records
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
        const exactTier = determineExactMatchTier(query, record);
        return { record, score, exactTier };
      })
      .filter(({ score }) => score > 0);

    // Deterministic sort for lexical candidates (strictly compareUtf8, zero localeCompare)
    scoredLexical.sort((a, b) => {
      // 1. exactTier DESC
      if (a.exactTier !== b.exactTier) return b.exactTier - a.exactTier;
      // 2. score DESC
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 1e-12) return scoreDiff > 0 ? 1 : -1;
      // 3. key ASC (strictly compareUtf8)
      const keyDiff = compareUtf8(a.record.key, b.record.key);
      if (keyDiff !== 0) return keyDiff;
      // 4. updatedAt DESC
      const updatedDiff = compareUtf8(b.record.updatedAt, a.record.updatedAt);
      if (updatedDiff !== 0) return updatedDiff;
      // 5. id ASC
      return compareUtf8(a.record.id, b.record.id);
    });

    const topLexicalCandidates = scoredLexical.slice(0, candidateLimit);

    // 2. Query Embedding (with timeout, abort signal, privacy, and store lifecycle checks)
    let queryVector: Float32Array | null = null;
    const isEligibleForSemantic =
      this.state === "open" &&
      Boolean(this.embeddingProvider) &&
      !containsSensitiveContent(query);

    if (isEligibleForSemantic) {
      const queryAbortController = new AbortController();
      let timeoutTimer: NodeJS.Timeout | undefined;

      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutTimer = setTimeout(() => {
          queryAbortController.abort();
          this.logSafeEmbeddingError(
            "search_embed_timeout",
            new Error("Query embedding timed out."),
          );
          resolve(null);
        }, this.searchEmbedTimeoutMs);
      });

      const embedPromise = (async () => {
        try {
          const normalized = normalizeEmbeddingInput(query);
          if (!normalized) return null;
          return await this.embeddingProvider!.embed(normalized, {
            signal: queryAbortController.signal,
          });
        } catch (error) {
          this.logSafeEmbeddingError("search_embed_failed", error);
          return null;
        }
      })();

      // Catch late rejections to prevent unhandled rejection
      embedPromise.catch((err) => {
        this.logSafeEmbeddingError("search_embed_late_rejection", err);
      });

      try {
        queryVector = await Promise.race([embedPromise, timeoutPromise]);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
    }

    // 3. Semantic Full Scan (if queryVector is available)
    let topSemanticCandidates: Array<{
      record: MemoryRecord;
      exactTier: ExactMatchTier;
      similarity: number;
    }> = [];
    const targetModelIdentity = this.getModelIdentity();

    if (queryVector && targetModelIdentity) {
      const validRows = await this.loadValidEmbeddingRows(targetModelIdentity);
      const scoredSemantic = validRows
        .map(({ record, vector }) => {
          const similarity = cosineSimilarity(queryVector!, vector);
          const exactTier = determineExactMatchTier(query, record);
          return { record, exactTier, similarity };
        })
        .filter((c) => Number.isFinite(c.similarity) && c.similarity > 0);

      // Deterministic sort for semantic candidates
      scoredSemantic.sort((a, b) => {
        // 1. similarity DESC
        const simDiff = b.similarity - a.similarity;
        if (Math.abs(simDiff) > 1e-12) return simDiff > 0 ? 1 : -1;
        // 2. updatedAt DESC
        const updatedDiff = compareUtf8(b.record.updatedAt, a.record.updatedAt);
        if (updatedDiff !== 0) return updatedDiff;
        // 3. key ASC
        const keyDiff = compareUtf8(a.record.key, b.record.key);
        if (keyDiff !== 0) return keyDiff;
        // 4. id ASC
        return compareUtf8(a.record.id, b.record.id);
      });

      topSemanticCandidates = scoredSemantic.slice(0, candidateLimit);
    }

    // 4. RRF Fusion
    if (topLexicalCandidates.length === 0 && topSemanticCandidates.length === 0) {
      return [];
    }

    const candidateRecordsMap = new Map<string, MemoryRecord>();
    const exactTiers = new Map<string, ExactMatchTier>();

    for (const item of topLexicalCandidates) {
      candidateRecordsMap.set(item.record.id, item.record);
      exactTiers.set(item.record.id, item.exactTier);
    }
    for (const item of topSemanticCandidates) {
      candidateRecordsMap.set(item.record.id, item.record);
      if (!exactTiers.has(item.record.id)) {
        exactTiers.set(item.record.id, item.exactTier);
      }
    }

    const rrfScored = computeRRF(
      topLexicalCandidates.map((c) => c.record),
      topSemanticCandidates.map((c) => c.record),
      exactTiers,
    );

    return rrfScored
      .slice(0, limit)
      .map((c) => candidateRecordsMap.get(c.id)!);
  }

  async history(key: string): Promise<MemoryRevision[]> {
    if (this.readOnly && tryLstatSync(this.filePath) === null) {
      return [];
    }
    return this.withDatabase(false, (db) => {
      if (this.readOnly && !this.hasTable(db, "memory_history")) {
        return [];
      }
      const statement = db.prepare("SELECT * FROM memory_history WHERE key = ? ORDER BY version");
      try {
        statement.bind([key]);
        const records: MemoryRevision[] = [];
        while (statement.step()) {
          const row = statement.getAsObject();
          records.push({ ...this.toRecord(row), revision: Number(row.version) });
        }
        return records;
      } finally {
        statement.free();
      }
    });
  }

  async delete(key: string): Promise<boolean> {
    this.assertWritable();
    if (!key.trim()) throw new Error("Key must not be empty.");
    return this.withDatabase(true, (db) =>
      this.runInTransaction(db, () => {
        const current = this.selectRecord(db, key);
        if (!current) return false;

        db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [current.id]);
        db.run("DELETE FROM memory_history WHERE key = ? OR id = ?", [key, current.id]);
        db.run("DELETE FROM memories WHERE key = ?", [key]);
        return true;
      }),
    );
  }

  async create(input: MemoryInput): Promise<MemoryRecord> {
    this.assertWritable();
    this.validate(input);
    const valueHash = computeEmbeddingInputHash(input.value);
    if (!valueHash) throw new Error("value_hash must not be empty.");
    const record = await this.withDatabase(true, (db) =>
      this.runInTransaction(db, () => {
        if (this.selectRecord(db, input.key)) throw new MemoryExistsError(input.key);
        const now = new Date().toISOString();
        const createdRecord: MemoryRecord = {
          ...input,
          id: randomUUID(),
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        db.run(
          "INSERT INTO memories (id, kind, key, value, provenance, version, value_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            createdRecord.id,
            createdRecord.kind,
            createdRecord.key,
            createdRecord.value,
            createdRecord.provenance,
            createdRecord.version,
            valueHash,
            now,
            now,
          ],
        );
        this.insertHistory(db, createdRecord, valueHash);
        return createdRecord;
      }),
    );
    this.enqueueBackgroundEmbedding(record.id, record.value, valueHash);
    return record;
  }

  async update(key: string, expectedVersion: number, correction: MemoryInput): Promise<MemoryRecord> {
    this.assertWritable();
    this.validate(correction);
    if (correction.key !== key) throw new Error("Correction key must match the target key");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error("expectedVersion must be a positive integer");
    }

    const newValueHash = computeEmbeddingInputHash(correction.value);
    if (!newValueHash) throw new Error("value_hash must not be empty.");
    let contentChanged = false;

    const updated = await this.withDatabase(true, (db) =>
      this.runInTransaction(db, () => {
        const current = this.selectRecord(db, key);
        if (!current || current.version !== expectedVersion) {
          throw new MemoryConflictError(key, expectedVersion, current?.version ?? null);
        }
        const currentValueHash = computeEmbeddingInputHash(current.value);
        contentChanged = currentValueHash !== newValueHash;

        const updatedRecord: MemoryRecord = {
          ...correction,
          id: current.id,
          version: current.version + 1,
          createdAt: current.createdAt,
          updatedAt: new Date().toISOString(),
        };
        db.run(
          "UPDATE memories SET kind = ?, value = ?, provenance = ?, version = ?, value_hash = ?, updated_at = ? WHERE key = ?",
          [
            updatedRecord.kind,
            updatedRecord.value,
            updatedRecord.provenance,
            updatedRecord.version,
            newValueHash,
            updatedRecord.updatedAt,
            key,
          ],
        );
        this.insertHistory(db, updatedRecord, newValueHash);
        if (contentChanged) {
          db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [current.id]);
        }
        return updatedRecord;
      }),
    );

    if (contentChanged) {
      this.enqueueBackgroundEmbedding(updated.id, updated.value, newValueHash);
    }

    return updated;
  }

  async createTask(input: TaskInput): Promise<TaskRecord> {
    this.assertWritable();
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
    if (this.readOnly && tryLstatSync(this.filePath) === null) {
      return null;
    }
    return this.withDatabase(false, (db) => {
      if (this.readOnly && !this.hasTable(db, "tasks")) {
        return null;
      }
      return this.selectTask(db, id);
    });
  }

  async updateTask(id: string, input: TaskUpdateInput): Promise<TaskRecord> {
    this.assertWritable();
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
    this.assertWritable();
    if (!input.taskId.trim()) throw new Error("Task ID must not be empty.");
    if (!input.eventType.trim()) throw new Error("Task event type must not be empty.");
    if (input.status !== undefined) this.validateTaskStatus(input.status);
    if (input.expectedStatus !== undefined) this.validateTaskStatus(input.expectedStatus);

    return this.withDatabase(true, (db) =>
      this.runInTransaction(db, () => {
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
      }),
    );
  }

  async listTaskEvents(taskId: string): Promise<TaskEventRecord[]> {
    if (this.readOnly && tryLstatSync(this.filePath) === null) {
      return [];
    }
    return this.withDatabase(false, (db) => {
      if (this.readOnly && !this.hasTable(db, "task_events")) {
        return [];
      }
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

  async listPendingEmbeddings(
    model: string,
    limit = 25,
    afterId?: string,
  ): Promise<PendingEmbeddingRecord[]> {
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      throw new Error("Embedding model identity must not be empty.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EMBEDDING_BATCH_SIZE) {
      throw new RangeError(
        `Batch limit must be an integer between 1 and ${MAX_EMBEDDING_BATCH_SIZE}.`,
      );
    }
    const cursor = afterId !== undefined && afterId.length > 0 ? afterId : null;

    this.assertJarvisPathSafe();
    if (this.readOnly && tryLstatSync(this.filePath) === null) {
      return [];
    }

    return this.withDatabase(false, (db) => {
      if (!this.hasTable(db, "memories")) {
        return [];
      }
      const hasEmbeddings = this.hasTable(db, "memory_embeddings");
      const hasValueHash = this.hasColumn(db, "memories", "value_hash");

      // If either memory_embeddings table or memories.value_hash column is missing,
      // all records in memories are treated as pending without querying m.value_hash.
      if (!hasEmbeddings || !hasValueHash) {
        const stmt = db.prepare(
          hasValueHash
            ? "SELECT id, value, value_hash FROM memories WHERE (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?"
            : "SELECT id, value FROM memories WHERE (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?",
        );
        stmt.bind([cursor, cursor, limit]);
        const pending: PendingEmbeddingRecord[] = [];
        try {
          while (stmt.step()) {
            const row = stmt.getAsObject();
            const value = String(row.value);
            const rawHash =
              hasValueHash && typeof row.value_hash === "string"
                ? row.value_hash.trim()
                : "";
            pending.push({
              id: String(row.id),
              value,
              valueHash: rawHash.length > 0 ? rawHash : computeEmbeddingInputHash(value),
            });
          }
          return pending;
        } finally {
          stmt.free();
        }
      }

      const statement = db.prepare(`
        SELECT m.id, m.value, m.value_hash
        FROM memories m
        LEFT JOIN memory_embeddings e
          ON m.id = e.memory_id AND e.model = ?
        WHERE (
          e.memory_id IS NULL
          OR m.value_hash IS NULL
          OR TRIM(m.value_hash) = ''
          OR e.content_hash IS NULL
          OR TRIM(e.content_hash) = ''
          OR e.content_hash != m.value_hash
        )
          AND (? IS NULL OR m.id > ?)
        ORDER BY m.id ASC
        LIMIT ?
      `);
      statement.bind([trimmedModel, cursor, cursor, limit]);
      const pending: PendingEmbeddingRecord[] = [];
      try {
        while (statement.step()) {
          const row = statement.getAsObject();
          const value = String(row.value);
          const rawHash =
            typeof row.value_hash === "string" ? row.value_hash.trim() : "";
          pending.push({
            id: String(row.id),
            value,
            valueHash: rawHash.length > 0 ? rawHash : computeEmbeddingInputHash(value),
          });
        }
        return pending;
      } finally {
        statement.free();
      }
    });
  }

  async saveEmbeddingsBatch(
    model: string,
    items: ReadonlyArray<PreparedEmbeddingItem>,
  ): Promise<SaveEmbeddingsBatchResult> {
    if (this.readOnly) {
      throw new Error("Cannot perform write operation on a read-only MemoryStore.");
    }
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      throw new Error("Embedding model identity must not be empty.");
    }
    if (items.length > MAX_EMBEDDING_BATCH_SIZE) {
      throw new RangeError(
        `Cannot save more than ${MAX_EMBEDDING_BATCH_SIZE} embeddings in a single batch.`,
      );
    }
    if (items.length === 0) {
      return { written: 0, skippedDeleted: 0, skippedStale: 0 };
    }

    return this.withDatabase(true, (db) => {
      db.run("BEGIN TRANSACTION;");
      try {
        const selectHashStmt = db.prepare("SELECT value_hash FROM memories WHERE id = ?");
        let written = 0;
        let skippedDeleted = 0;
        let skippedStale = 0;
        try {
          for (const item of items) {
            selectHashStmt.bind([item.memoryId]);
            const found = selectHashStmt.step();
            const row = found ? selectHashStmt.getAsObject() : null;
            selectHashStmt.reset();

            if (!row) {
              skippedDeleted += 1;
              continue;
            }
            if (
              typeof row.value_hash !== "string" ||
              !row.value_hash.trim() ||
              row.value_hash !== item.contentHash
            ) {
              skippedStale += 1;
              continue;
            }

            upsertMemoryEmbedding(db, {
              memoryId: item.memoryId,
              model: trimmedModel,
              dimensions: item.dimensions,
              contentHash: item.contentHash,
              vector: item.vector,
              indexedAt: item.indexedAt,
            });
            written += 1;
          }
        } finally {
          selectHashStmt.free();
        }
        db.run("COMMIT;");
        return { written, skippedDeleted, skippedStale };
      } catch (error) {
        try {
          db.run("ROLLBACK;");
        } catch {
          // Ignore rollback failure if transaction was already closed.
        }
        throw error;
      }
    });
  }

  async getEmbeddingStats(model: string): Promise<EmbeddingStats> {
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      throw new Error("Embedding model identity must not be empty.");
    }
    this.assertJarvisPathSafe();
    if (tryLstatSync(this.filePath) === null) {
      return {
        databaseExists: false,
        activeModel: trimmedModel,
        totalMemories: 0,
        indexedValid: 0,
        staleMismatched: 0,
        unindexed: 0,
        pendingTotal: 0,
        otherModels: [],
      };
    }

    return this.withDatabase(false, (db) => {
      if (!this.hasTable(db, "memories")) {
        return {
          databaseExists: true,
          activeModel: trimmedModel,
          totalMemories: 0,
          indexedValid: 0,
          staleMismatched: 0,
          unindexed: 0,
          pendingTotal: 0,
          otherModels: [],
        };
      }

      const totalRes = db.exec("SELECT COUNT(*) FROM memories");
      const totalMemories = Number(totalRes?.[0]?.values?.[0]?.[0] ?? 0);
      const hasEmbeddings = this.hasTable(db, "memory_embeddings");
      const hasValueHash = this.hasColumn(db, "memories", "value_hash");

      if (!hasEmbeddings) {
        return {
          databaseExists: true,
          activeModel: trimmedModel,
          totalMemories,
          indexedValid: 0,
          staleMismatched: 0,
          unindexed: totalMemories,
          pendingTotal: totalMemories,
          otherModels: [],
        };
      }

      let indexedValid = 0;
      let staleMismatched = 0;
      let unindexed = 0;

      if (hasValueHash) {
        const statsStmt = db.prepare(`
          SELECT
            COALESCE(SUM(CASE
              WHEN e.memory_id IS NOT NULL
                AND m.value_hash IS NOT NULL
                AND TRIM(m.value_hash) != ''
                AND e.content_hash IS NOT NULL
                AND TRIM(e.content_hash) != ''
                AND e.content_hash = m.value_hash
              THEN 1 ELSE 0
            END), 0) AS indexed_valid,
            COALESCE(SUM(CASE
              WHEN e.memory_id IS NOT NULL
                AND (
                  m.value_hash IS NULL
                  OR TRIM(m.value_hash) = ''
                  OR e.content_hash IS NULL
                  OR TRIM(e.content_hash) = ''
                  OR e.content_hash != m.value_hash
                )
              THEN 1 ELSE 0
            END), 0) AS stale_mismatched,
            COALESCE(SUM(CASE WHEN e.memory_id IS NULL THEN 1 ELSE 0 END), 0) AS unindexed
          FROM memories m
          LEFT JOIN memory_embeddings e
            ON m.id = e.memory_id AND e.model = ?
        `);
        statsStmt.bind([trimmedModel]);
        try {
          if (statsStmt.step()) {
            const row = statsStmt.getAsObject();
            indexedValid = Number(row.indexed_valid ?? 0);
            staleMismatched = Number(row.stale_mismatched ?? 0);
            unindexed = Number(row.unindexed ?? 0);
          }
        } finally {
          statsStmt.free();
        }
      } else {
        // When memories.value_hash column is absent, never synthesize hashes to mark embeddings valid;
        // all records are pending (either unindexed if no embedding row, or staleMismatched if an unverified embedding exists).
        const missingHashStmt = db.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN e.memory_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS stale_mismatched,
            COALESCE(SUM(CASE WHEN e.memory_id IS NULL THEN 1 ELSE 0 END), 0) AS unindexed
          FROM memories m
          LEFT JOIN memory_embeddings e
            ON m.id = e.memory_id AND e.model = ?
        `);
        missingHashStmt.bind([trimmedModel]);
        try {
          if (missingHashStmt.step()) {
            const row = missingHashStmt.getAsObject();
            indexedValid = 0;
            staleMismatched = Number(row.stale_mismatched ?? 0);
            unindexed = Number(row.unindexed ?? 0);
          }
        } finally {
          missingHashStmt.free();
        }
      }

      const otherModelsStmt = db.prepare(`
        SELECT model, COUNT(*) AS cnt
        FROM memory_embeddings
        WHERE model != ?
        GROUP BY model
        ORDER BY model ASC
      `);
      otherModelsStmt.bind([trimmedModel]);
      const otherModels: Array<{ model: string; count: number }> = [];
      try {
        while (otherModelsStmt.step()) {
          const row = otherModelsStmt.getAsObject();
          otherModels.push({
            model: String(row.model),
            count: Number(row.cnt ?? 0),
          });
        }
      } finally {
        otherModelsStmt.free();
      }

      return {
        databaseExists: true,
        activeModel: trimmedModel,
        totalMemories,
        indexedValid,
        staleMismatched,
        unindexed,
        pendingTotal: unindexed + staleMismatched,
        otherModels,
      };
    });
  }

  private async loadValidEmbeddingRows(
    modelIdentity: string,
  ): Promise<Array<{ record: MemoryRecord; vector: Float32Array }>> {
    if (this.readOnly && tryLstatSync(this.filePath) === null) {
      return [];
    }
    return this.withDatabase(false, (db) => {
      if (!this.hasTable(db, "memory_embeddings") || !this.hasTable(db, "memories")) {
        return [];
      }
      const hasValueHash = this.hasColumn(db, "memories", "value_hash");
      if (!hasValueHash) return [];

      const statement = db.prepare(`
        SELECT
          m.id, m.key, m.value, m.provenance, m.kind, m.version, m.created_at, m.updated_at,
          e.vector, e.dimensions, e.content_hash, m.value_hash
        FROM memory_embeddings e
        INNER JOIN memories m ON e.memory_id = m.id
        WHERE e.model = ?
          AND e.content_hash IS NOT NULL
          AND m.value_hash IS NOT NULL
          AND e.content_hash = m.value_hash
      `);
      try {
        statement.bind([modelIdentity]);
        const results: Array<{ record: MemoryRecord; vector: Float32Array }> = [];
        while (statement.step()) {
          const row = statement.getAsObject();
          const value = String(row.value ?? "");
          // Exclude sensitive memories from semantic search
          if (containsSensitiveContent(value)) {
            continue;
          }
          const rawVector = row.vector;
          if (!(rawVector instanceof Uint8Array)) {
            continue;
          }
          const dimensions = Number(row.dimensions);
          let vector: Float32Array;
          try {
            vector = deserializeEmbedding(rawVector, dimensions);
          } catch {
            continue;
          }
          results.push({
            record: {
              id: String(row.id),
              key: String(row.key),
              value,
              provenance: String(row.provenance ?? ""),
              kind: row.kind as MemoryKind,
              version: Number(row.version),
              createdAt: String(row.created_at),
              updatedAt: String(row.updated_at),
            },
            vector,
          });
        }
        return results;
      } finally {
        statement.free();
      }
    });
  }

  private hasTable(db: Database, tableName: string): boolean {
    const stmt = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    );
    stmt.bind([tableName]);
    try {
      return stmt.step();
    } finally {
      stmt.free();
    }
  }

  setEmbeddingProvider(provider: EmbeddingProvider | undefined): void {
    this.embeddingProvider = provider;
  }

  getEmbeddingProvider(): EmbeddingProvider | undefined {
    return this.embeddingProvider;
  }

  getState(): "open" | "closing" | "closed" {
    return this.state;
  }

  async waitForPendingEmbeddings(timeoutMs = 5000): Promise<void> {
    if (
      this.runningTasks === 0 &&
      this.backgroundQueue.length === 0 &&
      this.activeBackgroundWrites === 0
    ) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for pending embeddings (${timeoutMs}ms).`));
      }, timeoutMs);
    });

    const idlePromise = new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });

    try {
      await Promise.race([idlePromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state === "closed") {
      return Promise.resolve();
    }
    if (this.closePromise) {
      return this.closePromise;
    }

    const timeoutMs = options.timeoutMs ?? 5000;

    // 1. Transition to closing
    this.state = "closing";

    this.closePromise = (async () => {
      // 2. Prevent unstarted tasks and new writes from starting
      this.backgroundQueue.length = 0;

      // 3. Abort or wait for in-flight embedding network tasks up to timeoutMs
      this.abortController.abort();
      if (this.activeTaskPromises.size > 0 && timeoutMs > 0) {
        let taskTimer: NodeJS.Timeout | undefined;
        const taskTimeoutPromise = new Promise<void>((resolve) => {
          taskTimer = setTimeout(resolve, timeoutMs);
        });
        const tasksDonePromise = Promise.allSettled([...this.activeTaskPromises]).then(() => undefined);
        await Promise.race([tasksDonePromise, taskTimeoutPromise]);
        if (taskTimer) clearTimeout(taskTimer);
      }

      // 4. Wait unconditionally for all in-progress SQLite writes that already started to completely finish
      while (this.activeBackgroundWrites > 0) {
        await new Promise<void>((resolve) => {
          this.writeCompletionResolvers.push(resolve);
        });
      }

      // 5. Verify activeBackgroundWrites is 0
      if (this.activeBackgroundWrites !== 0) {
        throw new Error("Cannot close MemoryStore: active background writes still pending.");
      }

      // 6. Transition to closed permanently
      this.state = "closed";
    })();

    return this.closePromise;
  }

  private enqueueBackgroundEmbedding(
    memoryId: string,
    value: string,
    valueHash: string,
  ): void {
    if (this.state !== "open" || !this.embeddingProvider) {
      return;
    }

    const task = async () => {
      await this.runEmbeddingJob(memoryId, value, valueHash);
    };

    this.backgroundQueue.push(task);
    this.processQueue();
  }

  private processQueue(): void {
    if (this.state !== "open") {
      return;
    }

    while (this.runningTasks < this.maxConcurrency && this.backgroundQueue.length > 0) {
      const nextTask = this.backgroundQueue.shift();
      if (!nextTask) break;

      this.runningTasks++;
      const promise = nextTask()
        .catch((error) => {
          this.logSafeEmbeddingError("background_worker_unhandled", error);
        })
        .finally(() => {
          this.runningTasks--;
          this.activeTaskPromises.delete(promise);
          this.checkIdle();
          this.processQueue();
        });

      this.activeTaskPromises.add(promise);
    }
  }

  private checkIdle(): void {
    if (
      this.runningTasks === 0 &&
      this.backgroundQueue.length === 0 &&
      this.activeBackgroundWrites === 0
    ) {
      for (const resolve of this.idleResolvers) {
        resolve();
      }
      this.idleResolvers = [];
    }
  }

  private async runEmbeddingJob(
    memoryId: string,
    value: string,
    expectedValueHash: string,
  ): Promise<void> {
    // 1. Privacy check: never call provider or transmit sensitive content
    if (containsSensitiveContent(value)) {
      return;
    }

    // 2. Lifecycle check: if not open or aborted, exit
    if (this.state !== "open" || this.abortController.signal.aborted) {
      return;
    }

    const provider = this.embeddingProvider;
    if (!provider) return;

    const normalized = normalizeEmbeddingInput(value);
    if (!normalized) {
      return;
    }

    let vector: Float32Array;
    try {
      vector = await provider.embed(normalized, {
        signal: this.abortController.signal,
      });
    } catch (error) {
      if (this.abortController.signal.aborted || this.state !== "open") {
        return;
      }
      this.logSafeEmbeddingError("embedding_index_failed", error);
      return;
    }

    // 3. Atomically check state and begin write before touching SQLite
    if (!this.tryBeginBackgroundWrite()) {
      return;
    }

    try {
      if (this.embeddingProvider !== provider) {
        return;
      }

      const targetModel = this.getModelIdentity() ?? provider.modelName;

      await this.saveEmbeddingsBatch(targetModel, [
        {
          memoryId,
          dimensions: provider.dimensions,
          contentHash: expectedValueHash,
          vector,
        },
      ]);
    } catch (error) {
      this.logSafeEmbeddingError("embedding_index_failed", error);
    } finally {
      this.finishBackgroundWrite();
    }
  }

  private tryBeginBackgroundWrite(): boolean {
    if (this.state !== "open") {
      return false;
    }
    this.activeBackgroundWrites++;
    return true;
  }

  private finishBackgroundWrite(): void {
    this.activeBackgroundWrites--;
    if (this.activeBackgroundWrites === 0) {
      for (const resolve of this.writeCompletionResolvers) {
        resolve();
      }
      this.writeCompletionResolvers = [];
      this.checkIdle();
    }
  }

  private logSafeEmbeddingError(context: string, error: unknown): void {
    let safeReason = "unknown_error";
    if (error instanceof Error) {
      if ("status" in error && typeof (error as any).status === "number") {
        safeReason = `http_${(error as any).status}`;
      } else if (error.name === "EmbeddingTimeoutError" || error.name === "TimeoutError") {
        safeReason = "timeout";
      } else if (error.name === "EmbeddingConnectionError") {
        safeReason = "connection_error";
      } else if (error.name === "EmbeddingConfigurationError") {
        safeReason = "configuration_error";
      } else if (error.name === "EmbeddingResponseError") {
        safeReason = "invalid_response";
      } else if (error.name === "AbortError") {
        safeReason = "aborted";
      } else {
        safeReason = error.name || "error";
      }
    }
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[jarvis:${context}] ${safeReason}`);
    }
  }

  private assertWritable(): void {
    if (this.state !== "open") {
      throw new Error(`Cannot perform write operation on MemoryStore in ${this.state} state.`);
    }
    if (this.readOnly) {
      throw new Error("Cannot perform write operation on a read-only MemoryStore.");
    }
  }

  private runInTransaction<T>(db: Database, fn: () => T): T {
    db.run("BEGIN TRANSACTION;");
    try {
      const result = fn();
      db.run("COMMIT;");
      return result;
    } catch (error) {
      try {
        db.run("ROLLBACK;");
      } catch {
        // Ignore rollback failure if transaction was already closed.
      }
      throw error;
    }
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
    if (this.readOnly && write) {
      throw new Error("Cannot perform write operation on a read-only MemoryStore.");
    }
    const maxAttempts = write ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      this.assertJarvisPathSafe();
      const lockPath = `${this.filePath}.lock`;
      const lock = write ? await this.acquireLock(lockPath) : undefined;
      let db: Database | undefined;
      let tempPath: string | undefined;

      try {
        const SQL = await (MemoryStore.sqlPromise ??= initSqlJs());
        const snapshot = this.readDatabaseSnapshot();
        const preReadStat = snapshot.stat;
        db =
          snapshot.bytes !== null
            ? new SQL.Database(snapshot.bytes)
            : new SQL.Database();
        if (this.readOnly) {
          db.run("PRAGMA foreign_keys = ON;");
          assertForeignKeysEnabled(db);
        } else {
          this.initializeSchema(db);
        }
        const result = action(db);
        if (write && lock) {
          const bytes = Buffer.from(db.export());
          tempPath = join(
            dirname(this.filePath),
            `.${basename(this.filePath)}.${randomUUID()}.pending`,
          );
          this.assertJarvisPathSafe();
          writeFileSync(tempPath, bytes, { mode: 0o600 });
          chmodSync(tempPath, 0o600);
          if (!this.isWriteFenceValid(lockPath, lock, preReadStat)) {
            unlinkSync(tempPath);
            tempPath = undefined;
            if (attempt < maxAttempts) {
              continue;
            }
            throw new Error(
              "Memory write aborted because lock ownership or database snapshot changed before commit.",
            );
          }
          renameSync(tempPath, this.filePath);
          tempPath = undefined;
        }
        return result;
      } finally {
        db?.close();
        if (tempPath && existsSync(tempPath)) {
          try {
            unlinkSync(tempPath);
          } catch {
            // Ignore cleanup failure.
          }
        }
        if (lock) {
          await this.releaseMainLockIfOwned(lockPath, lock);
        }
      }
    }
  }

  private readDatabaseSnapshot(): { stat: Stats | null; bytes: Uint8Array | null } {
    this.assertJarvisPathSafe();
    let fd: number;
    try {
      fd = openSync(this.filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { stat: null, bytes: null };
      }
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      const bytes = new Uint8Array(readFileSync(fd));
      return { stat, bytes };
    } finally {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure.
      }
    }
  }

  private async acquireLock(lockPath: string): Promise<LockHandle> {
    this.assertJarvisPathSafe();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      const created = this.tryCreateLockFile(lockPath);
      if (created) {
        return created;
      }
      try {
        const inspection = this.inspectLockFile(lockPath);
        if (
          inspection.status !== "missing" &&
          this.isInspectionEvictable(inspection)
        ) {
          const evictedAndClaimed = this.tryEvictAndClaimStaleLock(
            lockPath,
            inspection,
          );
          if (evictedAndClaimed) {
            return evictedAndClaimed;
          }
        }
      } catch {
        // The lock may have been removed while being checked.
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for memory lock: ${lockPath}`);
      await delay(25);
    }
  }

  private createStageLockFile(targetLockPath: string): {
    stagePath: string;
    handle: LockHandle;
  } {
    const token = randomUUID();
    const createdAt = Date.now();
    const pid = process.pid;
    const payload = JSON.stringify({ createdAt, pid, token });
    const stagePath = `${targetLockPath}.${token}.stage`;
    let fd: number | undefined;
    let succeeded = false;
    try {
      fd = openSync(stagePath, "wx", 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, payload, "utf8");
      const ino = fstatSync(fd).ino;
      succeeded = true;
      return {
        stagePath,
        handle: { token, ino, createdAt, pid },
      };
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close failure.
        }
      }
      if (!succeeded) {
        try {
          unlinkSync(stagePath);
        } catch {
          // Ignore stage cleanup failure.
        }
      }
    }
  }

  private tryCreateLockFile(targetLockPath: string): LockHandle | null {
    if (tryLstatSync(targetLockPath) !== null) {
      return null;
    }
    const evictDirPath = `${targetLockPath}.evict`;
    const evictLock = this.acquireEvictLock(evictDirPath);
    if (!evictLock) {
      return null;
    }
    try {
      if (tryLstatSync(targetLockPath) !== null) {
        return null;
      }
      const { stagePath, handle } = this.createStageLockFile(targetLockPath);
      try {
        const preLinkCheck = this.inspectLockFile(stagePath);
        if (
          preLinkCheck.status !== "valid" ||
          preLinkCheck.ino !== handle.ino ||
          preLinkCheck.token !== handle.token ||
          preLinkCheck.pid !== handle.pid
        ) {
          return null;
        }
        linkSync(stagePath, targetLockPath);
        const postLinkCheck = this.inspectLockFile(targetLockPath);
        if (
          postLinkCheck.status !== "valid" ||
          postLinkCheck.ino !== handle.ino ||
          postLinkCheck.token !== handle.token ||
          postLinkCheck.pid !== handle.pid
        ) {
          return null;
        }
        return handle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return null;
        }
        throw error;
      } finally {
        try {
          unlinkSync(stagePath);
        } catch {
          // Ignore stage cleanup failure.
        }
      }
    } finally {
      this.releaseEvictLock(evictDirPath, evictLock);
    }
  }

  private tryEvictAndClaimStaleLock(
    lockPath: string,
    candidate: Exclude<LockInspection, { status: "missing" }>,
  ): LockHandle | null {
    const evictDirPath = `${lockPath}.evict`;
    const evictLock = this.acquireEvictLock(evictDirPath);
    if (!evictLock) {
      return null;
    }

    try {
      this.cleanupStaleStageFiles(lockPath);
      const current = this.inspectLockFile(lockPath);
      if (
        !this.doesInspectionMatchCandidate(current, candidate) ||
        !this.isInspectionEvictable(current)
      ) {
        return null;
      }
      const { stagePath, handle } = this.createStageLockFile(lockPath);
      try {
        const preRenameStageCheck = this.inspectLockFile(stagePath);
        if (
          preRenameStageCheck.status !== "valid" ||
          preRenameStageCheck.ino !== handle.ino ||
          preRenameStageCheck.token !== handle.token ||
          preRenameStageCheck.pid !== handle.pid
        ) {
          return null;
        }
        const beforeRename = this.inspectLockFile(lockPath);
        if (
          !this.doesInspectionMatchCandidate(beforeRename, candidate) ||
          !this.isInspectionEvictable(beforeRename)
        ) {
          return null;
        }
        renameSync(stagePath, lockPath);
        this.clearLockObservationTrackers(lockPath);
        const postRenameCheck = this.inspectLockFile(lockPath);
        if (
          postRenameCheck.status !== "valid" ||
          postRenameCheck.ino !== handle.ino ||
          postRenameCheck.token !== handle.token ||
          postRenameCheck.pid !== handle.pid
        ) {
          return null;
        }
        return handle;
      } finally {
        try {
          unlinkSync(stagePath);
        } catch {
          // Ignore stage cleanup failure when stagePath was renamed onto lockPath.
        }
      }
    } catch {
      return null;
    } finally {
      this.releaseEvictLock(evictDirPath, evictLock);
    }
  }

  private tryCreateEvictLock(evictDirPath: string): EvictLockHandle | null {
    const existingStat = tryLstatSync(evictDirPath);
    if (existingStat?.isSymbolicLink()) {
      throw new Error("SQLite lock path must not be a symbolic link.");
    }
    const token = randomUUID();
    const createdAt = Date.now();
    const pid = process.pid;
    const payload = JSON.stringify({ createdAt, pid, token });
    const stageDirPath = `${evictDirPath}.${token}.stage`;
    const stageEntryPath = join(stageDirPath, `${token}.lock`);
    let fd: number | undefined;
    let renamed = false;
    try {
      mkdirSync(stageDirPath, { mode: 0o700 });
      chmodSync(stageDirPath, 0o700);
      fd = openSync(stageEntryPath, "wx", 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, payload, "utf8");
      const ino = fstatSync(fd).ino;
      closeSync(fd);
      fd = undefined;
      const preRenameCheck = this.inspectLockFile(stageEntryPath);
      if (
        preRenameCheck.status !== "valid" ||
        preRenameCheck.ino !== ino ||
        preRenameCheck.token !== token ||
        preRenameCheck.pid !== pid
      ) {
        return null;
      }
      renameSync(stageDirPath, evictDirPath);
      renamed = true;
      this.clearLockObservationTrackers(evictDirPath);
      const entryPath = join(evictDirPath, `${token}.lock`);
      const postRenameCheck = this.inspectLockFile(entryPath);
      if (
        postRenameCheck.status !== "valid" ||
        postRenameCheck.ino !== ino ||
        postRenameCheck.token !== token ||
        postRenameCheck.pid !== pid
      ) {
        try {
          rmdirSync(evictDirPath);
        } catch {
          // Ignore rmdir failure if directory is non-empty or already removed.
        }
        return null;
      }
      return {
        token,
        ino,
        createdAt,
        pid,
        entryPath,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "EEXIST" ||
        code === "ENOTEMPTY" ||
        code === "ENOTDIR" ||
        code === "EBUSY" ||
        code === "EACCES" ||
        code === "EPERM"
      ) {
        return null;
      }
      throw error;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close failure.
        }
      }
      if (!renamed) {
        try {
          unlinkSync(stageEntryPath);
        } catch {
          // Ignore stage entry cleanup failure.
        }
        try {
          rmdirSync(stageDirPath);
        } catch {
          // Ignore stage dir cleanup failure.
        }
      }
    }
  }

  private acquireEvictLock(evictDirPath: string): EvictLockHandle | null {
    this.cleanupStaleStageFiles(evictDirPath);
    const created = this.tryCreateEvictLock(evictDirPath);
    if (created) {
      return created;
    }
    try {
      const stat = tryLstatSync(evictDirPath);
      if (stat === null) {
        return this.tryCreateEvictLock(evictDirPath);
      }
      if (stat.isSymbolicLink()) {
        throw new Error("SQLite lock path must not be a symbolic link.");
      }
      if (!stat.isDirectory()) {
        const fileInspection = this.inspectLockFile(evictDirPath);
        if (
          fileInspection.status === "missing" ||
          !this.isInspectionEvictable(fileInspection)
        ) {
          return null;
        }
        try {
          unlinkSync(evictDirPath);
          this.clearLockObservationTrackers(evictDirPath);
        } catch {
          return null;
        }
        return this.tryCreateEvictLock(evictDirPath);
      }

      const entries = readdirSync(evictDirPath);
      if (entries.length === 0) {
        const emptyDirAgeMs = this.observeIncompleteArtifactAge(evictDirPath, stat);
        if (emptyDirAgeMs <= INCOMPLETE_LOCK_STALE_MS) {
          return null;
        }
        return this.tryCreateEvictLock(evictDirPath);
      }

      const candidates: Array<{
        entryPath: string;
        inspection: Exclude<LockInspection, { status: "missing" }>;
      }> = [];

      for (const entryName of entries) {
        const entryPath = join(evictDirPath, entryName);
        const inspection = this.inspectLockFile(entryPath);
        if (inspection.status === "missing") {
          continue;
        }
        if (!this.isInspectionEvictable(inspection)) {
          return null;
        }
        candidates.push({ entryPath, inspection });
      }

      for (const { entryPath, inspection } of candidates) {
        const current = this.inspectLockFile(entryPath);
        if (
          !this.doesInspectionMatchCandidate(current, inspection) ||
          !this.isInspectionEvictable(current)
        ) {
          return null;
        }
        try {
          unlinkSync(entryPath);
          this.clearLockObservationTrackers(entryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            return null;
          }
        }
      }

      return this.tryCreateEvictLock(evictDirPath);
    } catch {
      return null;
    }
  }

  private releaseEvictLock(
    evictDirPath: string,
    evictLock: EvictLockHandle,
  ): boolean {
    try {
      const current = this.inspectLockFile(evictLock.entryPath);
      if (
        current.status !== "valid" ||
        current.ino !== evictLock.ino ||
        current.token !== evictLock.token ||
        current.pid !== evictLock.pid
      ) {
        return false;
      }
      try {
        unlinkSync(evictLock.entryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return false;
        }
      }
      try {
        rmdirSync(evictDirPath);
      } catch {
        // Directory is non-empty (replaced by a newer .evict token) or already removed.
      }
      this.clearLockObservationTrackers(evictLock.entryPath);
      return true;
    } catch {
      return false;
    }
  }

  private inspectLockFile(targetLockPath: string): LockInspection {
    const stat = tryLstatSync(targetLockPath);
    if (stat === null) {
      this.clearLockObservationTrackers(targetLockPath);
      return { status: "missing" };
    }
    if (stat.isSymbolicLink()) {
      throw new Error("SQLite lock path must not be a symbolic link.");
    }
    let raw: string;
    try {
      raw = readFileSync(targetLockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.clearLockObservationTrackers(targetLockPath);
        return { status: "missing" };
      }
      throw error;
    }
    const afterStat = tryLstatSync(targetLockPath);
    if (afterStat === null || afterStat.ino !== stat.ino) {
      this.clearLockObservationTrackers(targetLockPath);
      return { status: "missing" };
    }
    const now = Date.now();
    const inoKey = `${targetLockPath}:${stat.ino}`;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof parsed.createdAt === "number" &&
        Number.isFinite(parsed.createdAt) &&
        typeof parsed.pid === "number" &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.token === "string" &&
        parsed.token.trim().length > 0
      ) {
        MemoryStore.incompleteFirstSeenByIno.delete(inoKey);
        let firstSeenValid = MemoryStore.validFirstSeenByIno.get(inoKey);
        if (firstSeenValid === undefined) {
          firstSeenValid = now;
          MemoryStore.validFirstSeenByIno.set(inoKey, firstSeenValid);
        }
        const claimedAgeMs =
          parsed.createdAt <= now ? now - parsed.createdAt : 0;
        const observedValidAgeMs = Math.max(0, now - firstSeenValid);
        return {
          status: "valid",
          ino: stat.ino,
          createdAt: parsed.createdAt,
          pid: parsed.pid,
          token: parsed.token,
          ageMs: Math.max(claimedAgeMs, observedValidAgeMs),
        };
      }
    } catch {
      // Fall through to incomplete lock classification.
    }
    return {
      status: "incomplete",
      ino: stat.ino,
      ageMs: this.observeIncompleteArtifactAge(targetLockPath, stat),
    };
  }

  private observeIncompleteArtifactAge(targetPath: string, stat: Stats): number {
    const now = Date.now();
    const inoKey = `${targetPath}:${stat.ino}`;
    let firstSeen = MemoryStore.incompleteFirstSeenByIno.get(inoKey);
    if (firstSeen === undefined) {
      firstSeen = now;
      MemoryStore.incompleteFirstSeenByIno.set(inoKey, firstSeen);
    }
    const diskAgeMs =
      Number.isFinite(stat.mtimeMs) && stat.mtimeMs <= now
        ? now - stat.mtimeMs
        : 0;
    const observedAgeMs = Math.max(0, now - firstSeen);
    return Math.max(diskAgeMs, observedAgeMs);
  }

  private clearLockObservationTrackers(targetPath: string): void {
    const prefix = `${targetPath}:`;
    for (const key of MemoryStore.incompleteFirstSeenByIno.keys()) {
      if (key.startsWith(prefix)) {
        MemoryStore.incompleteFirstSeenByIno.delete(key);
      }
    }
    for (const key of MemoryStore.validFirstSeenByIno.keys()) {
      if (key.startsWith(prefix)) {
        MemoryStore.validFirstSeenByIno.delete(key);
      }
    }
  }

  private cleanupStaleStageFiles(targetPath: string): void {
    try {
      const dir = dirname(targetPath);
      const prefix = `${basename(targetPath)}.`;
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(prefix) || !name.endsWith(".stage")) {
          continue;
        }
        const stagePath = join(dir, name);
        const stat = tryLstatSync(stagePath);
        if (!stat || stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          const children = readdirSync(stagePath);
          if (children.length === 0) {
            // Ownership cannot be established reliably for an empty stage directory;
            // leave it intact rather than deleting a potentially active stage.
            continue;
          }
          const evictableChildren: Array<{
            childPath: string;
            inspection: Extract<LockInspection, { status: "valid" }>;
          }> = [];
          let allChildrenEvictable = true;
          for (const child of children) {
            const childPath = join(stagePath, child);
            const inspection = this.inspectLockFile(childPath);
            if (
              inspection.status !== "valid" ||
              this.isProcessAlive(inspection.pid) ||
              inspection.ageMs <= LOCK_STALE_MS
            ) {
              allChildrenEvictable = false;
              break;
            }
            evictableChildren.push({ childPath, inspection });
          }
          if (!allChildrenEvictable) {
            continue;
          }
          let safelyRemovedAllChildren = true;
          for (const { childPath, inspection } of evictableChildren) {
            const current = this.inspectLockFile(childPath);
            if (
              !this.doesInspectionMatchCandidate(current, inspection) ||
              current.status !== "valid" ||
              this.isProcessAlive(current.pid) ||
              current.ageMs <= LOCK_STALE_MS
            ) {
              safelyRemovedAllChildren = false;
              break;
            }
            try {
              unlinkSync(childPath);
              this.clearLockObservationTrackers(childPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                safelyRemovedAllChildren = false;
                break;
              }
            }
          }
          if (!safelyRemovedAllChildren) {
            continue;
          }
          try {
            rmdirSync(stagePath);
          } catch {
            // Ignore rmdir error if directory is non-empty or already removed.
          }
          this.clearLockObservationTrackers(stagePath);
        } else if (stat.isFile()) {
          const inspection = this.inspectLockFile(stagePath);
          if (
            inspection.status !== "valid" ||
            this.isProcessAlive(inspection.pid) ||
            inspection.ageMs <= LOCK_STALE_MS
          ) {
            continue;
          }
          const current = this.inspectLockFile(stagePath);
          if (
            !this.doesInspectionMatchCandidate(current, inspection) ||
            current.status !== "valid" ||
            this.isProcessAlive(current.pid) ||
            current.ageMs <= LOCK_STALE_MS
          ) {
            continue;
          }
          try {
            unlinkSync(stagePath);
          } catch {
            // Ignore unlink error.
          }
          this.clearLockObservationTrackers(stagePath);
        }
      }
    } catch {
      // Best-effort cleanup of abandoned staging artifacts.
    }
  }

  private isInspectionEvictable(inspection: LockInspection): boolean {
    if (inspection.status === "missing") {
      return false;
    }
    if (inspection.status === "incomplete") {
      return inspection.ageMs > INCOMPLETE_LOCK_STALE_MS;
    }
    const ownerIsAlive = this.isProcessAlive(inspection.pid);
    if (ownerIsAlive) {
      return false;
    }
    return inspection.ageMs > LOCK_STALE_MS;
  }

  private doesInspectionMatchCandidate(
    current: LockInspection,
    candidate: Exclude<LockInspection, { status: "missing" }>,
  ): boolean {
    if (candidate.status === "incomplete") {
      return (
        current.status === "incomplete" &&
        current.ino === candidate.ino
      );
    }
    return (
      current.status === "valid" &&
      current.ino === candidate.ino &&
      current.token === candidate.token &&
      current.pid === candidate.pid &&
      current.createdAt === candidate.createdAt
    );
  }

  private isWriteFenceValid(
    lockPath: string,
    lock: LockHandle,
    preReadStat: Stats | null,
  ): boolean {
    try {
      const currentLock = this.inspectLockFile(lockPath);
      if (
        currentLock.status !== "valid" ||
        currentLock.ino !== lock.ino ||
        currentLock.token !== lock.token ||
        currentLock.pid !== lock.pid
      ) {
        return false;
      }
      const currentDbStat = tryLstatSync(this.filePath);
      if (preReadStat === null) {
        return currentDbStat === null;
      }
      return (
        currentDbStat !== null &&
        currentDbStat.ino === preReadStat.ino &&
        currentDbStat.mtimeMs === preReadStat.mtimeMs &&
        currentDbStat.size === preReadStat.size
      );
    } catch {
      return false;
    }
  }

  private async releaseMainLockIfOwned(
    lockPath: string,
    lock: { token: string; ino: number; pid: number },
  ): Promise<boolean> {
    const evictDirPath = `${lockPath}.evict`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const preCheck = this.inspectLockFile(lockPath);
        if (
          preCheck.status !== "valid" ||
          preCheck.ino !== lock.ino ||
          preCheck.token !== lock.token ||
          preCheck.pid !== lock.pid
        ) {
          return false;
        }

        const evictLock = this.acquireEvictLock(evictDirPath);
        if (evictLock) {
          try {
            const current = this.inspectLockFile(lockPath);
            if (
              current.status !== "valid" ||
              current.ino !== lock.ino ||
              current.token !== lock.token ||
              current.pid !== lock.pid
            ) {
              return false;
            }
            unlinkSync(lockPath);
            this.clearLockObservationTrackers(lockPath);
            return true;
          } finally {
            this.releaseEvictLock(evictDirPath, evictLock);
          }
        }
      } catch {
        return false;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(10);
    }
  }

  private assertJarvisPathSafe(): void {
    if (this.jarvisDirectory) {
      assertNoSymbolicLinkComponents(this.jarvisDirectory, dirname(resolve(this.filePath)));
    }
    assertDatabaseFileNotSymlink(this.filePath);
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
    assertForeignKeysEnabled(db);

    db.run("BEGIN TRANSACTION;");
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('fact', 'goal', 'project', 'decision')),
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          provenance TEXT NOT NULL,
          version INTEGER NOT NULL,
          value_hash TEXT,
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
          value_hash TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (id, version)
        );
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_id TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          vector BLOB NOT NULL,
          indexed_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, model),
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
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
      this.ensureMemoryValueHash(db);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_memories_value_hash
          ON memories(value_hash);
        CREATE INDEX IF NOT EXISTS idx_memory_history_lookup
          ON memory_history(key, version);
        CREATE INDEX IF NOT EXISTS idx_memory_embeddings_lookup
          ON memory_embeddings(model, memory_id);
      `);
      db.run("COMMIT;");
    } catch (error) {
      try {
        db.run("ROLLBACK;");
      } catch {
        // Ignore rollback failure if transaction was already closed.
      }
      throw error;
    }
  }

  private hasColumn(db: Database, tableName: string, columnName: string): boolean {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`);
    try {
      while (columns.step()) {
        if (columns.getAsObject().name === columnName) {
          return true;
        }
      }
      return false;
    } finally {
      columns.free();
    }
  }

  private ensureMemoryValueHash(db: Database): void {
    const hasMemoriesValueHash = this.hasColumn(db, "memories", "value_hash");
    if (!hasMemoriesValueHash) {
      db.run("ALTER TABLE memories ADD COLUMN value_hash TEXT");
      const rows = db.prepare("SELECT id, value FROM memories WHERE value_hash IS NULL");
      const pendingUpdates: Array<{ id: string; valueHash: string }> = [];
      try {
        while (rows.step()) {
          const row = rows.getAsObject();
          if (typeof row.value !== "string" || !row.value.trim()) {
            throw new Error(`Cannot backfill value_hash for memory "${String(row.id)}": invalid value.`);
          }
          pendingUpdates.push({
            id: String(row.id),
            valueHash: computeEmbeddingInputHash(row.value),
          });
        }
      } finally {
        rows.free();
      }
      const updateStmt = db.prepare("UPDATE memories SET value_hash = ? WHERE id = ?");
      try {
        for (const item of pendingUpdates) {
          updateStmt.run([item.valueHash, item.id]);
        }
      } finally {
        updateStmt.free();
      }
    }

    const hasHistoryValueHash = this.hasColumn(db, "memory_history", "value_hash");
    if (!hasHistoryValueHash) {
      db.run("ALTER TABLE memory_history ADD COLUMN value_hash TEXT");
      const rows = db.prepare("SELECT id, version, value FROM memory_history WHERE value_hash IS NULL");
      const pendingUpdates: Array<{ id: string; version: number; valueHash: string }> = [];
      try {
        while (rows.step()) {
          const row = rows.getAsObject();
          if (typeof row.value !== "string" || !row.value.trim()) {
            throw new Error(
              `Cannot backfill value_hash for memory_history (${String(row.id)}, v${String(row.version)}): invalid value.`,
            );
          }
          pendingUpdates.push({
            id: String(row.id),
            version: Number(row.version),
            valueHash: computeEmbeddingInputHash(row.value),
          });
        }
      } finally {
        rows.free();
      }
      const updateStmt = db.prepare(
        "UPDATE memory_history SET value_hash = ? WHERE id = ? AND version = ?",
      );
      try {
        for (const item of pendingUpdates) {
          updateStmt.run([item.valueHash, item.id, item.version]);
        }
      } finally {
        updateStmt.free();
      }
    }

    this.verifyValueHashesNotNull(db);
  }

  private verifyValueHashesNotNull(db: Database): void {
    const nullMemories = db.exec(
      "SELECT COUNT(*) FROM memories WHERE value_hash IS NULL OR TRIM(value_hash) = ''",
    );
    const nullMemoriesCount = Number(nullMemories?.[0]?.values?.[0]?.[0] ?? 0);
    if (nullMemoriesCount > 0) {
      throw new Error(
        `Database integrity check failed: memories contains ${nullMemoriesCount} record(s) with NULL or empty value_hash.`,
      );
    }

    const nullHistory = db.exec(
      "SELECT COUNT(*) FROM memory_history WHERE value_hash IS NULL OR TRIM(value_hash) = ''",
    );
    const nullHistoryCount = Number(nullHistory?.[0]?.values?.[0]?.[0] ?? 0);
    if (nullHistoryCount > 0) {
      throw new Error(
        `Database integrity check failed: memory_history contains ${nullHistoryCount} record(s) with NULL or empty value_hash.`,
      );
    }
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
    try {
      return statement.step() ? this.toRecord(statement.getAsObject()) : null;
    } finally {
      statement.free();
    }
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

  private insertHistory(
    db: Database,
    record: MemoryRecord,
    valueHash = computeEmbeddingInputHash(record.value),
  ): void {
    if (!valueHash || !valueHash.trim()) {
      throw new Error("memory_history.value_hash must not be empty.");
    }
    db.run(
      "INSERT INTO memory_history (id, kind, key, value, provenance, version, value_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        record.id,
        record.kind,
        record.key,
        record.value,
        record.provenance,
        record.version,
        valueHash,
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

/**
 * Strict canonical normalization for exact matching.
 * Unlike lexical normalization, this preserves all hyphens, underscores, punctuation,
 * and token boundaries, preventing false matches like 'PRJ-9042' matching 'PRJ9042'.
 */
export function normalizeExactMatchText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .trim()
    .toLowerCase();
}

/**
 * Deterministic total comparator:
 * 1. Primary order: UTF-8 byte sequence comparison (Buffer.compare).
 * 2. Secondary fallback: UTF-16 code unit comparison (locale-independent charCodeAt loop).
 */
export function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  const bufLeft = Buffer.from(left, "utf8");
  const bufRight = Buffer.from(right, "utf8");
  const byteDiff = Buffer.compare(bufLeft, bufRight);
  if (byteDiff !== 0) {
    return byteDiff < 0 ? -1 : 1;
  }
  const minLen = Math.min(left.length, right.length);
  for (let i = 0; i < minLen; i++) {
    const diff = left.charCodeAt(i) - right.charCodeAt(i);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

/**
 * Robust, safe Cosine Similarity calculation between Float32Array vectors.
 * - Dimension mismatch -> 0
 * - Empty vector -> 0
 * - Non-finite values (NaN/Infinity) -> 0
 * - Zero norm -> 0
 * - Clamps output safely within [-1, 1] without destroying valid negative similarities.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (!(a instanceof Float32Array) || !(b instanceof Float32Array)) return 0;
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (!Number.isFinite(ai) || !Number.isFinite(bi)) return 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA <= 0 || normB <= 0) return 0;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denom) || denom <= 0) return 0;

  const sim = dot / denom;
  if (!Number.isFinite(sim)) return 0;
  return Math.max(-1, Math.min(1, sim));
}

export type ExactMatchTier = 0 | 1 | 2 | 3; // 3: exact key, 2: exact identifier, 1: exact full value, 0: none

export interface ExactMatchInput {
  key: string;
  value: string;
}

const EXACT_CODE_TOKEN_REGEX = /(?:[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+|\d{2,})/gu;

/**
 * Pure function to evaluate exact match tier:
 * Tier 3: Query normalized exactly equals record key normalized (Exact Key Match).
 * Tier 2: Query contains a distinct composite identifier or number token
 *         that exactly matches a token in the record without punctuation stripping (Exact Identifier Match).
 * Tier 1: Query normalized exactly equals record value normalized (Exact Full Value Match).
 * Tier 0: Partial / no exact match.
 */
export function determineExactMatchTier(query: string, record: ExactMatchInput): ExactMatchTier {
  const normQuery = normalizeExactMatchText(query);
  if (!normQuery) return 0;

  const normKey = normalizeExactMatchText(record.key);
  if (normQuery === normKey) {
    return 3;
  }

  const queryCodeTokens = new Set(normQuery.match(EXACT_CODE_TOKEN_REGEX) ?? []);
  if (queryCodeTokens.size > 0) {
    const recordCodeTokens = new Set([
      ...(normKey.match(EXACT_CODE_TOKEN_REGEX) ?? []),
      ...(normalizeExactMatchText(record.value).match(EXACT_CODE_TOKEN_REGEX) ?? []),
    ]);
    for (const token of queryCodeTokens) {
      if (recordCodeTokens.has(token)) {
        return 2;
      }
    }
  }

  const normVal = normalizeExactMatchText(record.value);
  if (normQuery === normVal) {
    return 1;
  }

  return 0;
}

export interface ScoredCandidate {
  id: string;
  key: string;
  updatedAt: string;
  exactTier: ExactMatchTier;
  rrfScore: number;
}

export const RRF_DEFAULT_K = 60;

/**
 * Pure RRF calculation with deterministic multi-level tie-breaking:
 * Formula: sum( 1 / (k + rank) ) for rank starting at 1.
 * Tie-breaking hierarchy:
 * 1. exactTier DESC (3 > 2 > 1 > 0)
 * 2. rrfScore DESC
 * 3. updatedAt DESC (ISO timestamp UTF-8 compare)
 * 4. key ASC (compareUtf8)
 * 5. id ASC (compareUtf8)
 */
export function computeRRF<T extends { id: string; key: string; updatedAt: string }>(
  lexicalCandidates: T[],
  semanticCandidates: T[],
  exactTiers: Map<string, ExactMatchTier>,
  k = RRF_DEFAULT_K,
): ScoredCandidate[] {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error("RRF constant k must be a positive integer.");
  }

  const candidatesById = new Map<string, T>();
  const scoreMap = new Map<string, number>();

  for (let rank = 1; rank <= lexicalCandidates.length; rank++) {
    const item = lexicalCandidates[rank - 1];
    candidatesById.set(item.id, item);
    const score = 1 / (k + rank);
    scoreMap.set(item.id, (scoreMap.get(item.id) ?? 0) + score);
  }

  for (let rank = 1; rank <= semanticCandidates.length; rank++) {
    const item = semanticCandidates[rank - 1];
    candidatesById.set(item.id, item);
    const score = 1 / (k + rank);
    scoreMap.set(item.id, (scoreMap.get(item.id) ?? 0) + score);
  }

  const result: ScoredCandidate[] = [];
  for (const [id, item] of candidatesById.entries()) {
    const tier = exactTiers.get(id) ?? 0;
    const rrfScore = scoreMap.get(id) ?? 0;
    result.push({
      id,
      key: item.key,
      updatedAt: item.updatedAt,
      exactTier: tier,
      rrfScore,
    });
  }

  result.sort((a, b) => {
    // 1. Exact Match Tier (3 > 2 > 1 > 0)
    if (a.exactTier !== b.exactTier) {
      return b.exactTier - a.exactTier;
    }
    // 2. RRF Score DESC
    const scoreDiff = b.rrfScore - a.rrfScore;
    if (Math.abs(scoreDiff) > 1e-12) {
      return scoreDiff > 0 ? 1 : -1;
    }
    // 3. UpdatedAt DESC (most recent first)
    const updatedDiff = compareUtf8(b.updatedAt, a.updatedAt);
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    // 4. Key ASC
    const keyDiff = compareUtf8(a.key, b.key);
    if (keyDiff !== 0) {
      return keyDiff;
    }
    // 5. Unique ID ASC
    return compareUtf8(a.id, b.id);
  });

  return result;
}
