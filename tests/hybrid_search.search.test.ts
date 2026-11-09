import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.NODE_ENV = "test";

import {
  MemoryStore,
  compareUtf8,
  computeEmbeddingInputHash,
  computeRRF,
  determineExactMatchTier,
  upsertMemoryEmbedding,
  type MemoryRecord,
} from "../src/memory";
import type { EmbeddingProvider } from "../src/embedding";
import { buildEmbeddingModelIdentity } from "../src/embedding_identity";

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  public embedCalls: string[] = [];
  public embedHandler?: (text: string, opts?: { signal?: AbortSignal }) => Promise<Float32Array>;

  constructor(modelName = "test-model", dimensions = 4) {
    this.modelName = modelName;
    this.dimensions = dimensions;
  }

  async embed(text: string, opts?: { signal?: AbortSignal }): Promise<Float32Array> {
    this.embedCalls.push(text);
    if (this.embedHandler) {
      return this.embedHandler(text, opts);
    }
    const vec = new Float32Array(this.dimensions);
    vec[0] = 1.0;
    return vec;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-hybrid-search-"));
  const dbPath = join(dir, "test.sqlite");
  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Deterministic Ordering (No localeCompare, A/a tie-break via compareUtf8)
// ---------------------------------------------------------------------------
test("Acceptance 1: deterministic ordering without localeCompare, A/a tie-break via compareUtf8", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const store = await MemoryStore.open(dbPath);

    // Two memories with identical lexical score, identical updatedAt, identical kind
    // Differing only by key: "A" vs "a"
    await store.create({
      kind: "fact",
      key: "a",
      value: "determinism test value",
      provenance: "manual",
    });
    await store.create({
      kind: "fact",
      key: "A",
      value: "determinism test value",
      provenance: "manual",
    });

    const results = await store.search("determinism");
    assert.strictEqual(results.length, 2);

    // In UTF-8 / ASCII: "A" (0x41) comes before "a" (0x61)
    // compareUtf8("A", "a") < 0
    assert.ok(compareUtf8("A", "a") < 0);
    assert.strictEqual(results[0].key, "A", "Record with key 'A' must precede 'a' via compareUtf8");
    assert.strictEqual(results[1].key, "a");

    await store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Different Model Identity with Same modelName -> 0 Semantic Candidates
// ---------------------------------------------------------------------------
test("Acceptance 2: different model identity with same modelName produces 0 semantic candidates and falls back to lexical", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const providerA = new MockEmbeddingProvider("shared-model", 4);
    const identityA = buildEmbeddingModelIdentity({
      provider: "custom",
      modelName: "shared-model",
      dimensions: 4,
      hashVersion: "v1",
      digest: "sha256:aaaa",
    }).identity;

    const storeA = await MemoryStore.open(dbPath, {
      embeddingProvider: providerA,
      modelIdentity: identityA,
    });

    // Create a memory that will be stored under identityA
    const mem1 = await storeA.create({
      kind: "fact",
      key: "k1",
      value: "apple orange banana",
      provenance: "manual",
    });

    // Wait for background embedding to write
    await storeA.waitForPendingEmbeddings();
    await storeA.close();

    // Now open storeB with identityB (same modelName "shared-model", different digest / identity)
    const providerB = new MockEmbeddingProvider("shared-model", 4);
    providerB.embedHandler = async () => new Float32Array([1, 0, 0, 0]);

    const identityB = buildEmbeddingModelIdentity({
      provider: "custom",
      modelName: "shared-model",
      dimensions: 4,
      hashVersion: "v1",
      digest: "sha256:bbbb",
    }).identity;

    const storeB = await MemoryStore.open(dbPath, {
      embeddingProvider: providerB,
      modelIdentity: identityB,
    });

    // Query that has 0 lexical overlap with "apple orange banana", but provider returned vector [1,0,0,0]
    // Because stored embeddings are under identityA, and storeB queries WHERE e.model = identityB,
    // 0 semantic candidates are loaded, and fallback to lexical produces empty results without error!
    const resultsNonLexical = await storeB.search("quantum mechanics", 10);
    assert.deepStrictEqual(resultsNonLexical, []);

    // But a lexical search for "apple" safely succeeds
    const resultsLexical = await storeB.search("apple", 10);
    assert.strictEqual(resultsLexical.length, 1);
    assert.strictEqual(resultsLexical[0].id, mem1.id);

    await storeB.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Query Embedding Timeout (Provider ignores signal, returns after 500ms, timeout 100ms)
// ---------------------------------------------------------------------------
test("Acceptance 3: provider ignoring AbortSignal returns after 500ms with 100ms timeout returns lexical without unhandled rejection", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    let lateEmbedFinished = false;
    const slowProvider = new MockEmbeddingProvider("slow-model", 4);
    slowProvider.embedHandler = async () => {
      return new Promise<Float32Array>((resolve) => {
        setTimeout(() => {
          lateEmbedFinished = true;
          resolve(new Float32Array([1, 0, 0, 0]));
        }, 500);
      });
    };

    const store = await MemoryStore.open(dbPath, {
      embeddingProvider: slowProvider,
      searchEmbedTimeoutMs: 100, // 100ms timeout
    });

    const mem = await store.create({
      kind: "fact",
      key: "fallback-key",
      value: "emergency response fallback",
      provenance: "manual",
    });

    const startTime = Date.now();
    const results = await store.search("fallback", 10);
    const duration = Date.now() - startTime;

    // Search must return quickly due to 100ms timeout, well before 500ms
    assert.ok(duration < 400, `Search took ${duration}ms, expected to return within ~100-250ms`);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, mem.id);

    // Wait for the slow promise to settle after 500ms to guarantee zero unhandled rejection
    await new Promise((r) => setTimeout(r, 450));
    assert.strictEqual(lateEmbedFinished, true);

    await store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Sensitive Query results in 0 embed calls
// ---------------------------------------------------------------------------
test("Acceptance 4: sensitive query results in 0 embed calls and uses lexical search only", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new MockEmbeddingProvider("provider-4", 4);
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    await store.create({
      kind: "fact",
      key: "safe-key",
      value: "regular database entry with token references",
      provenance: "manual",
    });

    // Wait for create's background embedding task to complete, then reset call counter
    await store.waitForPendingEmbeddings();
    provider.embedCalls = [];

    // Query containing sensitive credentials
    const sensitiveQuery = "my secret key sk-or-v1-abcdef1234567890abcdef1234567890 database";
    const results = await store.search(sensitiveQuery);

    assert.strictEqual(provider.embedCalls.length, 0, "Provider embed must NOT be called for sensitive query");
    assert.strictEqual(results.length, 1, "Lexical search must still find matching record");
    assert.strictEqual(results[0].key, "safe-key");

    await store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Preserves Existing Lexical Search & SEMANTIC_CONCEPTS Rules
// ---------------------------------------------------------------------------
test("Acceptance 5: preserves existing lexical scoring, provenance matching, and SEMANTIC_CONCEPTS rules", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const store = await MemoryStore.open(dbPath);

    // Memory matching key (+3), value (+2), provenance (+1)
    const rec1 = await store.create({
      kind: "fact",
      key: "kubernetes-cluster",
      value: "running production pods",
      provenance: "infrastructure-docs",
    });

    // Memory matching SEMANTIC_CONCEPTS / SEMANTIC_MATCH_RULES:
    // keyConcepts: ["color", "test"] -> queryConcepts: ["color", "test"]
    const rec2 = await store.create({
      kind: "fact",
      key: "test-favorite-color",
      value: "cerulean blue",
      provenance: "experiments",
    });

    // 1. Literal search via provenance
    const resultsLiteral = await store.search("infrastructure-docs");
    assert.strictEqual(resultsLiteral.length, 1);
    assert.strictEqual(resultsLiteral[0].id, rec1.id);

    // 2. Semantic concept rule match:
    // Query "What colour was chosen during testing?" matches "test-favorite-color" via semantic rules
    const resultsConcept = await store.search("What colour was chosen during testing?");
    assert.ok(resultsConcept.some((r) => r.id === rec2.id), "Should match test-favorite-color via semantic concept rules");

    await store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Exclude Stale, Orphan, and Sensitive Vectors from Semantic Results
// ---------------------------------------------------------------------------
test("Acceptance 6: excludes stale, orphan, and sensitive vectors from semantic results", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new MockEmbeddingProvider("filter-model", 4);
    // Query vector matches [1, 0, 0, 0]
    provider.embedHandler = async () => new Float32Array([1, 0, 0, 0]);

    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    // Valid memory 1
    const validRec = await store.create({
      kind: "fact",
      key: "valid-memory",
      value: "completely unique text 1",
      provenance: "manual",
    });

    // Memory 2 that will become stale
    const staleRec = await store.create({
      kind: "fact",
      key: "stale-memory",
      value: "completely unique text 2",
      provenance: "manual",
    });

    // Memory 3 that is sensitive
    const sensitiveRec = await store.create({
      kind: "fact",
      key: "sensitive-memory",
      value: "super confidential token sk-or-v1-abcdef1234567890abcdef1234567890",
      provenance: "manual",
    });

    await store.waitForPendingEmbeddings();

    const modelIdentity = store.getModelIdentity()!;
    await (store as any).withDatabase(true, (db: any) => {
      // 1. Make stale: change value_hash in memories so content_hash !== value_hash
      db.run("UPDATE memories SET value_hash = 'different_hash_now' WHERE id = ?", [staleRec.id]);

      // 2. Add orphan embedding row (temporarily disable foreign keys to simulate orphan row from old or corrupted DB)
      db.run("PRAGMA foreign_keys = OFF;");
      upsertMemoryEmbedding(db, {
        memoryId: "non-existent-orphan-id",
        model: modelIdentity,
        dimensions: 4,
        contentHash: "orphan_hash",
        vector: new Float32Array([1, 0, 0, 0]),
      });
      db.run("PRAGMA foreign_keys = ON;");

      // 3. Force an embedding for the sensitive memory too (to verify it gets filtered out of semantic candidates)
      upsertMemoryEmbedding(db, {
        memoryId: sensitiveRec.id,
        model: modelIdentity,
        dimensions: 4,
        contentHash: computeEmbeddingInputHash(sensitiveRec.value),
        vector: new Float32Array([1, 0, 0, 0]),
      });
    });

    // Search with a query that has ZERO lexical match with any memory
    // ("xyznonexistentterm"), but semantic vector [1, 0, 0, 0] matches perfectly.
    const results = await store.search("xyznonexistentterm", 10);

    // Only validRec should be returned!
    const resultIds = results.map((r) => r.id);
    assert.ok(resultIds.includes(validRec.id), "Valid memory vector must be returned");
    assert.ok(!resultIds.includes(staleRec.id), "Stale vector must NOT be returned");
    assert.ok(!resultIds.includes(sensitiveRec.id), "Sensitive memory vector must NOT be returned");
    assert.ok(!resultIds.includes("non-existent-orphan-id"), "Orphan vector must NOT be returned");

    await store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. Full Scan Evaluates All Valid Vectors Before Candidate Limit Truncation
// ---------------------------------------------------------------------------
test("Acceptance 7: full scan evaluates all valid vectors before candidate limit truncation", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new MockEmbeddingProvider("full-scan-model", 4);
    // Query vector: [1, 0, 0, 0]
    provider.embedHandler = async () => new Float32Array([1, 0, 0, 0]);

    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    // With limit = 1, candidateLimit = Math.min(Math.max(1 * 10, 50), 200) = 50.
    // Seed 55 memories that have 0 lexical match with query "semanticquerytarget".
    // Memories 1..54 have vector [0.5, 0.5, 0, 0] (cosine similarity ~0.707).
    // Memory 55 (seeded last) has vector [1, 0, 0, 0] (cosine similarity 1.0).
    const modelIdentity = store.getModelIdentity()!;
    let targetMemId = "";

    const memories: MemoryRecord[] = [];
    for (let i = 1; i <= 55; i++) {
      const rec = await store.create({
        kind: "fact",
        key: `noise-item-${i.toString().padStart(3, "0")}`,
        value: `noise payload description number ${i}`,
        provenance: "manual",
      });
      memories.push(rec);
      if (i === 55) {
        targetMemId = rec.id;
      }
    }
    await store.waitForPendingEmbeddings();

    // Now update all embedding vectors directly
    await (store as any).withDatabase(true, (db: any) => {
      for (let i = 0; i < 54; i++) {
        const mem = memories[i];
        upsertMemoryEmbedding(db, {
          memoryId: mem.id,
          model: modelIdentity,
          dimensions: 4,
          contentHash: computeEmbeddingInputHash(mem.value),
          vector: new Float32Array([0.5, 0.5, 0, 0]),
        });
      }
      // Target memory 55 gets the perfect vector [1, 0, 0, 0]
      const targetMem = memories[54];
      upsertMemoryEmbedding(db, {
        memoryId: targetMem.id,
        model: modelIdentity,
        dimensions: 4,
        contentHash: computeEmbeddingInputHash(targetMem.value),
        vector: new Float32Array([1, 0, 0, 0]),
      });
    });

    // Limit is 1 -> candidateLimit is 50.
    // If truncation happened before evaluating all 55 vectors, memory 55 would never be scored.
    const results = await store.search("semanticquerytarget", 1);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, targetMemId, "Memory 55 with highest similarity must win #1");

    await store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. Exact Match Tiers Priority (Tier 3/2 beats high cosine similarity)
// ---------------------------------------------------------------------------
test("Acceptance 8: exact match tiers preserve priority (Tier 2 beats 0.99 cosine similarity)", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new MockEmbeddingProvider("tier-model", 4);
    // Query vector: [1, 0, 0, 0]
    provider.embedHandler = async () => new Float32Array([1, 0, 0, 0]);

    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    // Memory A: exact identifier "PRJ-9042" (Tier 2), but vector is orthogonal [0, 1, 0, 0]
    const exactRec = await store.create({
      kind: "fact",
      key: "jira-task",
      value: "working on PRJ-9042 sprint release",
      provenance: "manual",
    });

    // Memory B: high semantic match [1, 0, 0, 0] (similarity 1.0), but Tier 0 exact match
    const semanticRec = await store.create({
      kind: "fact",
      key: "unrelated-task",
      value: "completely unrelated text without codes",
      provenance: "manual",
    });

    await store.waitForPendingEmbeddings();

    const modelIdentity = store.getModelIdentity()!;
    await (store as any).withDatabase(true, (db: any) => {
      upsertMemoryEmbedding(db, {
        memoryId: exactRec.id,
        model: modelIdentity,
        dimensions: 4,
        contentHash: computeEmbeddingInputHash(exactRec.value),
        vector: new Float32Array([0, 1, 0, 0]), // orthogonal -> similarity 0
      });
      upsertMemoryEmbedding(db, {
        memoryId: semanticRec.id,
        model: modelIdentity,
        dimensions: 4,
        contentHash: computeEmbeddingInputHash(semanticRec.value),
        vector: new Float32Array([1, 0, 0, 0]), // similarity 1.0
      });
    });

    const results = await store.search("PRJ-9042", 5);

    // exactRec (Tier 2) must beat semanticRec (Tier 0) and take rank 1!
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0].id, exactRec.id, "Tier 2 exact match must beat 1.0 cosine similarity");

    await store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. Graceful Fallback When Provider Fails
// ---------------------------------------------------------------------------
test("Acceptance 9: graceful fallback to lexical search when provider throws error", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const failingProvider = new MockEmbeddingProvider("failing-model", 4);
    failingProvider.embedHandler = async () => {
      throw new Error("Ollama connection refused ECONNREFUSED");
    };

    const store = await MemoryStore.open(dbPath, { embeddingProvider: failingProvider });

    const mem = await store.create({
      kind: "fact",
      key: "network-fallback-key",
      value: "resilient offline data",
      provenance: "manual",
    });

    // Search must NOT throw; it catches provider failure and returns lexical result
    const results = await store.search("offline", 5);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, mem.id);

    await store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 10. Deterministic Tie-Breaking on Equal Scores
// ---------------------------------------------------------------------------
test("Acceptance 10: deterministic 5-level tie-breaking hierarchy on equal scores", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new MockEmbeddingProvider("tie-model", 4);
    // Query vector matches [1, 0, 0, 0]
    provider.embedHandler = async () => new Float32Array([1, 0, 0, 0]);

    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    // Memory 1 (older): matches query lexically, but vector is orthogonal [0, 1, 0, 0]
    // -> rank 1 in lexical, 0 in semantic -> RRF score = 1/61, exactTier = 0
    const olderLexical = await store.create({
      kind: "fact",
      key: "z-lexical-key",
      value: "contains searchword and other details",
      provenance: "manual",
    });

    await new Promise((r) => setTimeout(r, 20));

    // Memory 2 (newer): zero lexical match, but vector [1, 0, 0, 0] matches query vector
    // -> 0 in lexical, rank 1 in semantic -> RRF score = 1/61, exactTier = 0
    const newerSemantic = await store.create({
      kind: "fact",
      key: "a-semantic-key",
      value: "completely unrelated words for semantic lookup",
      provenance: "manual",
    });

    await store.waitForPendingEmbeddings();

    const modelIdentity = store.getModelIdentity()!;
    await (store as any).withDatabase(true, (db: any) => {
      upsertMemoryEmbedding(db, {
        memoryId: olderLexical.id,
        model: modelIdentity,
        dimensions: 4,
        contentHash: computeEmbeddingInputHash(olderLexical.value),
        vector: new Float32Array([0, 1, 0, 0]), // orthogonal -> similarity 0
      });
      upsertMemoryEmbedding(db, {
        memoryId: newerSemantic.id,
        model: modelIdentity,
        dimensions: 4,
        contentHash: computeEmbeddingInputHash(newerSemantic.value),
        vector: new Float32Array([1, 0, 0, 0]), // matches query vector -> similarity 1.0
      });
    });

    // Both have exactTier 0, and RRF score = 1/61.
    // Level 3 tie-breaker (updatedAt DESC) must pick newerSemantic over olderLexical!
    const results = await store.search("searchword", 5);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(
      results[0].id,
      newerSemantic.id,
      "Newer memory must win tie-breaker level 3 (updatedAt DESC) when RRF scores are equal",
    );
    assert.strictEqual(results[1].id, olderLexical.id);

    // Level 4 & 5 tie-breaker verification:
    // With identical RRF score, identical tier, identical updatedAt:
    const candA = { id: "id-2", key: "alpha-key", updatedAt: "2026-11-08T00:00:00Z" };
    const candB = { id: "id-1", key: "beta-key", updatedAt: "2026-11-08T00:00:00Z" };
    const rrfLevel4 = computeRRF([candB], [candA], new Map());
    assert.strictEqual(rrfLevel4[0].key, "alpha-key", "Level 4: key ASC via compareUtf8 must win");

    // With identical updatedAt and identical key:
    const candId1 = { id: "id-1", key: "same-key", updatedAt: "2026-11-08T00:00:00Z" };
    const candId2 = { id: "id-2", key: "same-key", updatedAt: "2026-11-08T00:00:00Z" };
    const rrfLevel5 = computeRRF([candId2], [candId1], new Map());
    assert.strictEqual(rrfLevel5[0].id, "id-1", "Level 5: id ASC via compareUtf8 must win");

    await store.close();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11. Post-Close Search Regression Test (Lexical search succeeds, 0 embed calls)
// ---------------------------------------------------------------------------
test("Acceptance 11: post-close search executes lexical search locally without calling embeddingProvider", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new MockEmbeddingProvider("post-close-model", 4);
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    const mem = await store.create({
      kind: "fact",
      key: "post-close-key",
      value: "offline post close capability test",
      provenance: "manual",
    });

    // Wait for create background embedding task to complete and reset calls counter
    await store.waitForPendingEmbeddings();
    provider.embedCalls = [];

    // Close the store
    await store.close();
    assert.strictEqual(store.getState(), "closed");

    // Execute search after close
    const results = await store.search("offline capability", 5);

    // Verify search returns expected memory and provider.embed was not called
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, mem.id);
    assert.strictEqual(
      provider.embedCalls.length,
      0,
      "embeddingProvider.embed() must not be called when search runs on closed store",
    );
  } finally {
    cleanup();
  }
});
