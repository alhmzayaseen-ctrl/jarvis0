import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import initSqlJs from "sql.js";

import {
  MemoryStore,
  assertForeignKeysEnabled,
  computeEmbeddingInputHash,
  upsertMemoryEmbedding,
} from "../src/memory";

function createTempDbPath(prefix: string): string {
  return join(tmpdir(), `jarvis-${prefix}-${randomUUID()}.sqlite`);
}

function cleanupDbFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}.lock`]) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

function createSampleVector(dimensions = 1024, seed = 0.5): Float32Array {
  const vector = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    vector[i] = Math.fround(seed + (i % 10) * 0.01);
  }
  return vector;
}

test("deleting a record directly via raw SQL from memories automatically deletes its embeddings via CASCADE", async () => {
  const dbPath = createTempDbPath("raw-sql-cascade");
  try {
    const store = await MemoryStore.open(dbPath);
    const created = await store.create({
      kind: "project",
      key: "jarvis-core",
      value: "Semantic memory foundation",
      provenance: "user",
    });

    const SQL = await initSqlJs();
    const rawDb = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      rawDb.run("PRAGMA foreign_keys = ON;");
      assertForeignKeysEnabled(rawDb);

      const contentHash = computeEmbeddingInputHash(created.value);
      // Insert two embeddings for different models under the same memory_id
      upsertMemoryEmbedding(rawDb, {
        memoryId: created.id,
        model: "bge-m3:latest",
        dimensions: 1024,
        contentHash,
        vector: createSampleVector(1024, 0.25),
      });
      upsertMemoryEmbedding(rawDb, {
        memoryId: created.id,
        model: "nomic-embed-text-v2-moe:latest",
        dimensions: 768,
        contentHash,
        vector: createSampleVector(768, 0.75),
      });

      const beforeDelete = rawDb.exec(
        "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?",
        [created.id],
      );
      assert.equal(Number(beforeDelete[0].values[0][0]), 2);

      // Delete directly from memories via raw SQL (bypassing MemoryStore.delete)
      rawDb.run("DELETE FROM memories WHERE id = ?", [created.id]);

      const afterDelete = rawDb.exec(
        "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?",
        [created.id],
      );
      assert.equal(Number(afterDelete[0].values[0][0]), 0);
    } finally {
      rawDb.close();
    }
  } finally {
    cleanupDbFiles(dbPath);
  }
});

test("disabling Foreign Keys causes an immediate and clear failure on verification", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    // By default or when explicitly disabled, PRAGMA foreign_keys is 0
    db.run("PRAGMA foreign_keys = OFF;");
    assert.throws(
      () => assertForeignKeysEnabled(db),
      /SQLite foreign keys enforcement failed: PRAGMA foreign_keys is not enabled \(expected 1\)/,
    );

    // Enabling makes verification pass
    db.run("PRAGMA foreign_keys = ON;");
    assert.doesNotThrow(() => assertForeignKeysEnabled(db));
  } finally {
    db.close();
  }
});

test("MemoryStore.open fails with SQLite foreign keys enforcement failed when PRAGMA foreign_keys = ON is ineffective and leaves no partial DB changes", async () => {
  const freshDbPath = createTempDbPath("fk-open-fresh-fail");
  const existingDbPath = createTempDbPath("fk-open-existing-fail");
  try {
    // Prepare a valid existing database first and snapshot its bytes
    const validStore = await MemoryStore.open(existingDbPath);
    const saved = await validStore.create({
      kind: "fact",
      key: "intact-record",
      value: "Must remain completely untouched if foreign_keys check fails",
      provenance: "test",
    });
    const beforeBytes = readFileSync(existingDbPath);

    const SQL = await initSqlJs();
    const originalRun = SQL.Database.prototype.run;

    try {
      mock.method(
        SQL.Database.prototype,
        "run",
        function (this: InstanceType<typeof SQL.Database>, sql: string, params?: unknown) {
          if (sql.trim().toUpperCase().startsWith("PRAGMA FOREIGN_KEYS")) {
            return originalRun.call(this, "PRAGMA foreign_keys = OFF;");
          }
          return originalRun.call(this, sql, params as never);
        },
      );

      // 1. Fresh database open must fail and write nothing to disk
      await assert.rejects(
        () => MemoryStore.open(freshDbPath),
        /SQLite foreign keys enforcement failed/,
      );
      assert.equal(existsSync(freshDbPath), false, "Failed fresh open must not create partial DB file");
      assert.equal(existsSync(`${freshDbPath}.lock`), false, "Lock file must be cleaned up");

      // 2. Existing database open must fail and leave existing bytes untouched
      await assert.rejects(
        () => MemoryStore.open(existingDbPath),
        /SQLite foreign keys enforcement failed/,
      );
      assert.equal(existsSync(`${existingDbPath}.lock`), false, "Lock file must be cleaned up");
      const afterBytes = readFileSync(existingDbPath);
      assert.equal(
        Buffer.compare(beforeBytes, afterBytes),
        0,
        "Existing database bytes must remain completely unchanged upon failed open",
      );
    } finally {
      mock.restoreAll();
    }

    // Verify existing database is still valid and intact after restoring mocks
    const reopened = await MemoryStore.open(existingDbPath);
    assert.deepEqual(await reopened.get("intact-record"), saved);
  } finally {
    mock.restoreAll();
    cleanupDbFiles(freshDbPath);
    cleanupDbFiles(existingDbPath);
  }
});

test("MemoryStore.update preserves embeddings when value_hash is unchanged and deletes them when value_hash changes", async () => {
  const dbPath = createTempDbPath("selective-invalidation");
  try {
    const store = await MemoryStore.open(dbPath);
    const created = await store.create({
      kind: "fact",
      key: "project-status",
      value: "Phase 2.1 in progress",
      provenance: "initial",
    });

    const SQL = await initSqlJs();
    const rawDb = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    rawDb.run("PRAGMA foreign_keys = ON;");
    upsertMemoryEmbedding(rawDb, {
      memoryId: created.id,
      model: "bge-m3:latest",
      dimensions: 1024,
      contentHash: computeEmbeddingInputHash(created.value),
      vector: createSampleVector(1024, 0.1),
    });
    writeFileSync(dbPath, Buffer.from(rawDb.export()));
    rawDb.close();

    // 1. Update provenance and kind only (with trailing whitespace that normalizes to the same hash)
    const updatedMetadataOnly = await store.update("project-status", 1, {
      kind: "project",
      key: "project-status",
      value: "  Phase 2.1 in progress  \r\n",
      provenance: "updated provenance",
    });
    assert.equal(updatedMetadataOnly.version, 2);

    const checkDb1 = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      const countAfterMetaUpdate = checkDb1.exec(
        "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?",
        [created.id],
      );
      assert.equal(Number(countAfterMetaUpdate[0].values[0][0]), 1);
    } finally {
      checkDb1.close();
    }

    // 2. Update actual value content so value_hash changes -> embedding must be invalidated
    await store.update("project-status", 2, {
      kind: "project",
      key: "project-status",
      value: "Phase 2.1 completed and verified",
      provenance: "updated provenance",
    });

    const checkDb2 = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      const countAfterValueUpdate = checkDb2.exec(
        "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?",
        [created.id],
      );
      assert.equal(Number(countAfterValueUpdate[0].values[0][0]), 0);
    } finally {
      checkDb2.close();
    }
  } finally {
    cleanupDbFiles(dbPath);
  }
});

test("MemoryStore.delete removes memory, history, and embeddings cleanly", async () => {
  const dbPath = createTempDbPath("store-delete-assurance");
  try {
    const store = await MemoryStore.open(dbPath);
    const created = await store.create({
      kind: "fact",
      key: "ephemeral-key",
      value: "Temporary fact",
      provenance: "test",
    });

    const SQL = await initSqlJs();
    const rawDb = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    rawDb.run("PRAGMA foreign_keys = ON;");
    upsertMemoryEmbedding(rawDb, {
      memoryId: created.id,
      model: "bge-m3:latest",
      dimensions: 1024,
      contentHash: computeEmbeddingInputHash(created.value),
      vector: createSampleVector(1024, 0.3),
    });
    writeFileSync(dbPath, Buffer.from(rawDb.export()));
    rawDb.close();

    const deleted = await store.delete("ephemeral-key");
    assert.equal(deleted, true);

    const checkDb = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      const embCount = checkDb.exec(
        "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?",
        [created.id],
      );
      assert.equal(Number(embCount[0].values[0][0]), 0);
    } finally {
      checkDb.close();
    }
  } finally {
    cleanupDbFiles(dbPath);
  }
});
