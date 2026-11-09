import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import initSqlJs from "sql.js";

import {
  MemoryStore,
  computeEmbeddingInputHash,
  deserializeEmbedding,
  serializeEmbedding,
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

test("round-trip of 1024 Float32 values produces 4096-byte Little-endian BLOB and preserves exact values", () => {
  const original = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    // Mix positive, negative, zero, and fractional Float32 values
    original[i] = Math.fround(Math.sin(i * 0.1) * 100 - 25.125);
  }
  original[0] = 0.0;
  original[1] = -0.5;
  original[2] = Math.fround(3.14159265);

  const blob = serializeEmbedding(original);
  assert.equal(blob.byteLength, 4096);

  // Verify explicit Little-endian encoding using DataView at index 2
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  assert.equal(view.getFloat32(2 * 4, true), original[2]);

  const decoded = deserializeEmbedding(blob, 1024);
  assert.equal(decoded.length, 1024);
  for (let i = 0; i < 1024; i++) {
    assert.equal(decoded[i], original[i], `Mismatch at index ${i}`);
  }
});

test("serializeEmbedding and deserializeEmbedding reject invalid inputs, NaN, Infinity, and mismatched BLOB sizes", () => {
  assert.throws(() => serializeEmbedding(new Float32Array(0)), /non-empty Float32Array/);

  const withNaN = new Float32Array([1.0, Number.NaN, 2.0]);
  assert.throws(() => serializeEmbedding(withNaN), /non-finite value at index 1/);

  const withInf = new Float32Array([1.0, Number.POSITIVE_INFINITY]);
  assert.throws(() => serializeEmbedding(withInf), /non-finite value at index 1/);

  const wrongSizeBlob = Buffer.alloc(4092);
  assert.throws(
    () => deserializeEmbedding(wrongSizeBlob, 1024),
    /Invalid embedding BLOB size: expected 4096 bytes for 1024 dimensions, got 4092 bytes/,
  );
});

test("deserializeEmbedding handles subarray with byteOffset > 0 and rejects NaN, Infinity, and invalid dimensions", () => {
  // 1. Subarray with non-zero byteOffset inside a larger padded buffer
  const original = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    original[i] = Math.fround((i - 512) * 0.03125);
  }
  const serialized = serializeEmbedding(original);

  const backingArrayBuffer = new ArrayBuffer(137 + 4096 + 89);
  const fullBytes = new Uint8Array(backingArrayBuffer);
  fullBytes.fill(0xff); // Fill surrounding bytes with 0xFF (NaN bit pattern if misread!)
  fullBytes.set(serialized, 137);

  const offsetSlice = fullBytes.subarray(137, 137 + 4096);
  assert.equal(offsetSlice.byteOffset, 137);
  assert.equal(offsetSlice.byteLength, 4096);

  const decodedFromSlice = deserializeEmbedding(offsetSlice, 1024);
  assert.equal(decodedFromSlice.length, 1024);
  for (let i = 0; i < 1024; i++) {
    assert.equal(decodedFromSlice[i], original[i], `Subarray mismatch at index ${i}`);
  }

  // 2. Reject NaN, +Infinity, and -Infinity embedded inside a 4096-byte BLOB
  const nanBlob = Buffer.from(serialized);
  new DataView(nanBlob.buffer, nanBlob.byteOffset, nanBlob.byteLength).setFloat32(
    17 * 4,
    Number.NaN,
    true,
  );
  assert.throws(
    () => deserializeEmbedding(nanBlob, 1024),
    /Deserialized embedding contains non-finite value at index 17/,
  );

  const posInfBlob = Buffer.from(serialized);
  new DataView(posInfBlob.buffer, posInfBlob.byteOffset, posInfBlob.byteLength).setFloat32(
    512 * 4,
    Number.POSITIVE_INFINITY,
    true,
  );
  assert.throws(
    () => deserializeEmbedding(posInfBlob, 1024),
    /Deserialized embedding contains non-finite value at index 512/,
  );

  const negInfBlob = Buffer.from(serialized);
  new DataView(negInfBlob.buffer, negInfBlob.byteOffset, negInfBlob.byteLength).setFloat32(
    1023 * 4,
    Number.NEGATIVE_INFINITY,
    true,
  );
  assert.throws(
    () => deserializeEmbedding(negInfBlob, 1024),
    /Deserialized embedding contains non-finite value at index 1023/,
  );

  // 3. Reject invalid expectedDimensions: 0, -1, 1.5, NaN
  for (const invalidDim of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => deserializeEmbedding(serialized, invalidDim),
      /expectedDimensions must be a positive integer/,
      `Expected dimension ${String(invalidDim)} to be rejected`,
    );
  }
});

test("repeated UPSERT with identical (memory_id, model) does not produce duplicate records and updates indexed_at", async () => {
  const dbPath = createTempDbPath("upsert-idempotent");
  try {
    const store = await MemoryStore.open(dbPath);
    const created = await store.create({
      kind: "fact",
      key: "embedding-target",
      value: "Multilingual semantic memory in Jarvis Core",
      provenance: "test",
    });

    const SQL = await initSqlJs();
    const db = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
    try {
      db.run("PRAGMA foreign_keys = ON;");

      const vec1 = new Float32Array(1024);
      vec1.fill(0.125);
      const vec2 = new Float32Array(1024);
      vec2.fill(0.875);

      const contentHash = computeEmbeddingInputHash(created.value);
      const t1 = "2026-11-08T12:00:00.000Z";
      const t2 = "2026-11-08T13:00:00.000Z";

      // 1st UPSERT
      upsertMemoryEmbedding(db, {
        memoryId: created.id,
        model: "bge-m3:latest",
        dimensions: 1024,
        contentHash,
        vector: vec1,
        indexedAt: t1,
      });

      // 2nd UPSERT with identical inputs
      upsertMemoryEmbedding(db, {
        memoryId: created.id,
        model: "bge-m3:latest",
        dimensions: 1024,
        contentHash,
        vector: vec1,
        indexedAt: t1,
      });

      // 3rd UPSERT updating vector and indexed_at for same (memory_id, model)
      upsertMemoryEmbedding(db, {
        memoryId: created.id,
        model: "bge-m3:latest",
        dimensions: 1024,
        contentHash,
        vector: vec2,
        indexedAt: t2,
      });

      const rows = db.exec(
        "SELECT memory_id, model, dimensions, content_hash, vector, indexed_at FROM memory_embeddings WHERE memory_id = ?",
        [created.id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].values.length, 1, "Must contain exactly 1 record (no duplicates)");

      const [memoryId, model, dimensions, storedHash, storedBlob, indexedAt] = rows[0].values[0];
      assert.equal(memoryId, created.id);
      assert.equal(model, "bge-m3:latest");
      assert.equal(dimensions, 1024);
      assert.equal(storedHash, contentHash);
      assert.equal(indexedAt, t2);

      const roundTripVector = deserializeEmbedding(storedBlob as Uint8Array, 1024);
      assert.equal(roundTripVector[0], 0.875);
      assert.equal(roundTripVector[1023], 0.875);
    } finally {
      db.close();
    }
  } finally {
    cleanupDbFiles(dbPath);
  }
});
