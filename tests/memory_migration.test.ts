import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import initSqlJs from "sql.js";

import {
  EMBEDDING_HASH_VERSION,
  MemoryStore,
  computeEmbeddingInputHash,
  normalizeEmbeddingInput,
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

test("computeEmbeddingInputHash normalizes trim, CRLF/CR, and Unicode NFC with v1 prefix", () => {
  const raw = "  مرحبا بك في Jarvis 🚀\r\nسطر جديد\rسطر ثالث  \n ";
  const normalized = normalizeEmbeddingInput(raw);
  assert.equal(normalized, "مرحبا بك في Jarvis 🚀\nسطر جديد\nسطر ثالث");

  const expectedHash = createHash("sha256")
    .update(`${EMBEDDING_HASH_VERSION}:${normalized}`, "utf8")
    .digest("hex");

  assert.equal(computeEmbeddingInputHash(raw), expectedHash);
  assert.equal(
    computeEmbeddingInputHash("مرحبا بك في Jarvis 🚀\nسطر جديد\nسطر ثالث"),
    expectedHash,
  );

  // Unicode NFC vs NFD equivalence (e.g., Arabic + Latin accented characters)
  const nfcText = "Café — اللائحة الأولى";
  const nfdText = nfcText.normalize("NFD");
  assert.notEqual(nfcText, nfdText);
  assert.equal(computeEmbeddingInputHash(nfcText), computeEmbeddingInputHash(nfdText));
});

test("migrates legacy database twice idempotently and backfills memories and memory_history with zero NULLs", async () => {
  const dbPath = createTempDbPath("legacy-migration");
  let store1: MemoryStore | null = null;
  let store2: MemoryStore | null = null;
  try {
    const SQL = await initSqlJs();
    const legacyDb = new SQL.Database();
    try {
      // Create pre-Phase-2.1 legacy schema without value_hash or memory_embeddings
      legacyDb.run(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('fact', 'goal', 'project', 'decision')),
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          provenance TEXT NOT NULL,
          version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE memory_history (
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
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE task_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          event_type TEXT NOT NULL,
          content TEXT,
          created_at TEXT NOT NULL
        );
      `);

      const now = "2026-11-08T10:00:00.000Z";
      const later = "2026-11-08T11:00:00.000Z";

      // Insert legacy memory at version 2
      legacyDb.run(
        "INSERT INTO memories (id, kind, key, value, provenance, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ["mem-1", "project", "jarvis-core", "Current updated v2 value", "user", 2, now, later],
      );
      // Insert two distinct historical versions into memory_history
      legacyDb.run(
        "INSERT INTO memory_history (id, kind, key, value, provenance, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ["mem-1", "project", "jarvis-core", "Original v1 historical value", "user", 1, now, now],
      );
      legacyDb.run(
        "INSERT INTO memory_history (id, kind, key, value, provenance, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ["mem-1", "project", "jarvis-core", "Current updated v2 value", "user", 2, now, later],
      );

      writeFileSync(dbPath, Buffer.from(legacyDb.export()));
    } finally {
      legacyDb.close();
    }

    // 1st migration run via MemoryStore.open
    store1 = await MemoryStore.open(dbPath);
    const retrieved1 = await store1.get("jarvis-core");
    assert.ok(retrieved1);
    assert.equal(retrieved1.value, "Current updated v2 value");

    // Inspect migrated database directly
    const migratedDb1 = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      const nullMemories = migratedDb1.exec(
        "SELECT COUNT(*) FROM memories WHERE value_hash IS NULL OR TRIM(value_hash) = ''",
      );
      assert.equal(Number(nullMemories[0].values[0][0]), 0);

      const nullHistory = migratedDb1.exec(
        "SELECT COUNT(*) FROM memory_history WHERE value_hash IS NULL OR TRIM(value_hash) = ''",
      );
      assert.equal(Number(nullHistory[0].values[0][0]), 0);

      // Verify each historical revision has its own value's hash
      const historyHashes = migratedDb1.exec(
        "SELECT version, value_hash FROM memory_history WHERE id = 'mem-1' ORDER BY version ASC",
      );
      assert.equal(historyHashes[0].values.length, 2);
      assert.equal(
        historyHashes[0].values[0][1],
        computeEmbeddingInputHash("Original v1 historical value"),
      );
      assert.equal(
        historyHashes[0].values[1][1],
        computeEmbeddingInputHash("Current updated v2 value"),
      );
      assert.notEqual(historyHashes[0].values[0][1], historyHashes[0].values[1][1]);
    } finally {
      migratedDb1.close();
    }

    // 2nd consecutive migration run (Idempotency check)
    store2 = await MemoryStore.open(dbPath);
    const retrieved2 = await store2.get("jarvis-core");
    assert.deepEqual(retrieved2, retrieved1);

    const migratedDb2 = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      const nullMemories2 = migratedDb2.exec(
        "SELECT COUNT(*) FROM memories WHERE value_hash IS NULL OR TRIM(value_hash) = ''",
      );
      assert.equal(Number(nullMemories2[0].values[0][0]), 0);

      const nullHistory2 = migratedDb2.exec(
        "SELECT COUNT(*) FROM memory_history WHERE value_hash IS NULL OR TRIM(value_hash) = ''",
      );
      assert.equal(Number(nullHistory2[0].values[0][0]), 0);
    } finally {
      migratedDb2.close();
    }
  } finally {
    try {
      if (store1) {
        await store1.close();
      }
    } finally {
      try {
        if (store2) {
          await store2.close();
        }
      } finally {
        cleanupDbFiles(dbPath);
      }
    }
  }
});

test("inserting a record with value_hash = NULL causes MemoryStore.open to reject with a clear error message", async () => {
  const dbPath = createTempDbPath("null-hash-rejection");
  let store: MemoryStore | null = null;
  try {
    store = await MemoryStore.open(dbPath);
    await store.create({
      kind: "fact",
      key: "valid-key",
      value: "Valid memory value",
      provenance: "test",
    });
    await store.close();
    store = null;

    // Corrupt the database by inserting a row with value_hash = NULL into memories
    const SQL = await initSqlJs();
    const rawDb = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      rawDb.run(
        "INSERT INTO memories (id, kind, key, value, provenance, version, value_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "corrupt-id",
          "fact",
          "corrupt-key",
          "Some value",
          "test",
          1,
          null,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
      writeFileSync(dbPath, Buffer.from(rawDb.export()));
    } finally {
      rawDb.close();
    }

    await assert.rejects(
      () => MemoryStore.open(dbPath),
      /Database integrity check failed: memories contains 1 record\(s\) with NULL or empty value_hash/,
    );
  } finally {
    try {
      if (store) {
        await store.close();
      }
    } finally {
      cleanupDbFiles(dbPath);
    }
  }
});

test("inserting a history record with value_hash = NULL causes MemoryStore.open to reject with a clear error message", async () => {
  const dbPath = createTempDbPath("null-history-hash-rejection");
  let store: MemoryStore | null = null;
  try {
    store = await MemoryStore.open(dbPath);
    await store.create({
      kind: "fact",
      key: "valid-key",
      value: "Valid memory value",
      provenance: "test",
    });
    await store.close();
    store = null;

    const SQL = await initSqlJs();
    const rawDb = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      rawDb.run(
        "INSERT INTO memory_history (id, kind, key, value, provenance, version, value_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "corrupt-hist-id",
          "fact",
          "corrupt-key",
          "Some value",
          "test",
          1,
          null,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
      writeFileSync(dbPath, Buffer.from(rawDb.export()));
    } finally {
      rawDb.close();
    }

    await assert.rejects(
      () => MemoryStore.open(dbPath),
      /Database integrity check failed: memory_history contains 1 record\(s\) with NULL or empty value_hash/,
    );
  } finally {
    try {
      if (store) {
        await store.close();
      }
    } finally {
      cleanupDbFiles(dbPath);
    }
  }
});

test("MemoryStore.create and MemoryStore.update persist normalized v1 SHA-256 value_hash in memories and memory_history", async () => {
  const dbPath = createTempDbPath("store-create-update-hash");
  let store: MemoryStore | null = null;
  try {
    store = await MemoryStore.open(dbPath);

    const rawInitialArabic = "   ذاكرة جارفيس الدلالية باللغة العربية\r\nالنسخة الأولى للاختبار   \r\n";
    const expectedInitialNormalized = "ذاكرة جارفيس الدلالية باللغة العربية\nالنسخة الأولى للاختبار".normalize("NFC");
    const expectedInitialHash = createHash("sha256")
      .update(`${EMBEDDING_HASH_VERSION}:${expectedInitialNormalized}`, "utf8")
      .digest("hex");

    const created = await store.create({
      kind: "project",
      key: "arabic-semantic-memory",
      value: rawInitialArabic,
      provenance: "user",
    });

    const SQL = await initSqlJs();
    const dbAfterCreate = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      const memRow = dbAfterCreate.exec(
        "SELECT value_hash FROM memories WHERE id = ?",
        [created.id],
      );
      assert.equal(memRow[0].values[0][0], expectedInitialHash);

      const histRow = dbAfterCreate.exec(
        "SELECT version, value_hash FROM memory_history WHERE id = ? ORDER BY version ASC",
        [created.id],
      );
      assert.equal(histRow[0].values.length, 1);
      assert.deepEqual(histRow[0].values[0], [1, expectedInitialHash]);
    } finally {
      dbAfterCreate.close();
    }

    const rawUpdatedArabic = "\r\n  تحديث ذاكرة جارفيس الدلالية باللغة العربية\r\nالنسخة الثانية الموثقة  \n";
    const expectedUpdatedNormalized = "تحديث ذاكرة جارفيس الدلالية باللغة العربية\nالنسخة الثانية الموثقة".normalize("NFC");
    const expectedUpdatedHash = createHash("sha256")
      .update(`${EMBEDDING_HASH_VERSION}:${expectedUpdatedNormalized}`, "utf8")
      .digest("hex");
    assert.notEqual(expectedInitialHash, expectedUpdatedHash);

    const updated = await store.update("arabic-semantic-memory", 1, {
      kind: "project",
      key: "arabic-semantic-memory",
      value: rawUpdatedArabic,
      provenance: "user-correction",
    });
    assert.equal(updated.version, 2);

    const dbAfterUpdate = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      const memRow2 = dbAfterUpdate.exec(
        "SELECT version, value_hash FROM memories WHERE id = ?",
        [created.id],
      );
      assert.deepEqual(memRow2[0].values[0], [2, expectedUpdatedHash]);

      const histRows2 = dbAfterUpdate.exec(
        "SELECT version, value, value_hash FROM memory_history WHERE id = ? ORDER BY version ASC",
        [created.id],
      );
      assert.equal(histRows2[0].values.length, 2);

      // Revision 1 preserves its own historical normalized hash
      assert.equal(histRows2[0].values[0][0], 1);
      assert.equal(histRows2[0].values[0][1], rawInitialArabic);
      assert.equal(histRows2[0].values[0][2], expectedInitialHash);
      assert.equal(
        histRows2[0].values[0][2],
        computeEmbeddingInputHash(String(histRows2[0].values[0][1])),
      );

      // Revision 2 stores the updated normalized hash
      assert.equal(histRows2[0].values[1][0], 2);
      assert.equal(histRows2[0].values[1][1], rawUpdatedArabic);
      assert.equal(histRows2[0].values[1][2], expectedUpdatedHash);
      assert.equal(
        histRows2[0].values[1][2],
        computeEmbeddingInputHash(String(histRows2[0].values[1][1])),
      );
    } finally {
      dbAfterUpdate.close();
    }
  } finally {
    try {
      if (store) {
        await store.close();
      }
    } finally {
      cleanupDbFiles(dbPath);
    }
  }
});
