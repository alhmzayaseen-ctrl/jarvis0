import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.NODE_ENV = "test";

import {
  MemoryStore,
  compareUtf8,
  computeRRF,
  RRF_DEFAULT_K,
} from "../src/memory";
import type { EmbeddingProvider } from "../src/embedding";
import { createChatServices } from "../src/chat";
import { OpenRouterProvider } from "../src/openrouter";

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  public embedCalls: string[] = [];
  public activeConcurrent = 0;
  public maxConcurrent = 0;
  public delayMs = 0;
  public shouldFail = false;
  public deferredHooks: Map<string, Deferred<void>> = new Map();

  constructor(modelName = "fake-bge-m3", dimensions = 4) {
    this.modelName = modelName;
    this.dimensions = dimensions;
  }

  async embed(text: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Float32Array> {
    if (opts?.signal?.aborted) {
      throw new Error("Aborted before start");
    }
    this.embedCalls.push(text);
    this.activeConcurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.activeConcurrent);

    try {
      const hook = this.deferredHooks.get(text);
      if (hook) {
        await hook.promise;
      }
      if (this.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
      if (opts?.signal?.aborted) {
        throw new Error("Aborted during embed");
      }
      if (this.shouldFail) {
        throw new Error("Simulated embedding provider failure");
      }
      const vec = new Float32Array(this.dimensions);
      vec[0] = 1.0;
      return vec;
    } finally {
      this.activeConcurrent--;
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-hybrid-test-"));
  const dbPath = join(dir, "test.sqlite");
  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

test("Phase 1 verification: compareUtf8('A', 'a') < 0 and computeRRF id tie-break", () => {
  // 1. Explicitly assert 'A' < 'a'
  assert.equal(compareUtf8("A", "a") < 0, true, "'A' (0x41) must strictly precede 'a' (0x61) in UTF-8 byte order");
  assert.equal(compareUtf8("a", "A") > 0, true);

  // 2. computeRRF: when all criteria (exact tier, score, updatedAt, key) are identical,
  // the tie must be broken by id ASC using compareUtf8 ('A' comes before 'a')
  const candUpper = { id: "A", key: "same-key", updatedAt: "2026-11-09T00:00:00Z" };
  const candLower = { id: "a", key: "same-key", updatedAt: "2026-11-09T00:00:00Z" };

  // Candidate with id 'a' is in lexical at rank 1 (score 1/61)
  // Candidate with id 'A' is in semantic at rank 1 (score 1/61)
  // Both have identical tier (0), identical score (1/61), identical updatedAt, identical key
  const ranked = computeRRF([candLower], [candUpper], new Map(), RRF_DEFAULT_K);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, "A", "Candidate with id 'A' must rank before 'a'");
  assert.equal(ranked[1].id, "a", "Candidate with id 'a' must rank after 'A'");
});

test("write-path scenario 1: embedding success after create", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    const record = await store.create({
      kind: "fact",
      key: "user-lang",
      value: "Arabic and English",
      provenance: "user-explicit",
    });
    assert.ok(record.id);

    // Wait for background queue to complete indexing
    await store.waitForPendingEmbeddings();

    assert.equal(provider.embedCalls.length, 1);
    assert.equal(provider.embedCalls[0], "Arabic and English");

    const stats = await store.getEmbeddingStats(provider.modelName);
    assert.equal(stats.totalMemories, 1);
    assert.equal(stats.indexedValid, 1);
    assert.equal(stats.unindexed, 0);
    assert.equal(stats.pendingTotal, 0);

    const pending = await store.listPendingEmbeddings(provider.modelName);
    assert.equal(pending.length, 0);

    await store.close();
  } finally {
    cleanup();
  }
});

test("write-path scenario 2: provider failure does not fail create and memory stays in pending", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    provider.shouldFail = true;

    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    // create() must succeed even if background embedding fails
    const record = await store.create({
      kind: "fact",
      key: "offline-fact",
      value: "Saved during Ollama outage",
      provenance: "user-explicit",
    });
    assert.ok(record.id);

    await store.waitForPendingEmbeddings();

    // Provider was attempted once
    assert.equal(provider.embedCalls.length, 1);

    // Memory record is safe in SQLite
    const fetched = await store.get("offline-fact");
    assert.ok(fetched);
    assert.equal(fetched.value, "Saved during Ollama outage");

    // Memory is tracked as pending and unindexed
    const stats = await store.getEmbeddingStats(provider.modelName);
    assert.equal(stats.totalMemories, 1);
    assert.equal(stats.indexedValid, 0);
    assert.equal(stats.unindexed, 1);
    assert.equal(stats.pendingTotal, 1);

    const pending = await store.listPendingEmbeddings(provider.modelName);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, record.id);

    await store.close();
  } finally {
    cleanup();
  }
});

test("write-path scenario 3: update race - slow older update does not overwrite newer fast update", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    // Initial record
    await store.create({
      kind: "fact",
      key: "status",
      value: "initial state",
      provenance: "user",
    });
    await store.waitForPendingEmbeddings();

    // Hook update A's value to hang
    const slowValue = "version 2 (slow A)";
    const fastValue = "version 3 (fast B)";
    const slowDeferred = new Deferred<void>();
    provider.deferredHooks.set(slowValue, slowDeferred);

    // Trigger update A (slow)
    const updateAPromise = store.update("status", 1, {
      kind: "fact",
      key: "status",
      value: slowValue,
      provenance: "user",
    });
    const updateA = await updateAPromise;
    assert.equal(updateA.version, 2);

    // Trigger update B (fast) with expectedVersion 2
    const updateB = await store.update("status", 2, {
      kind: "fact",
      key: "status",
      value: fastValue,
      provenance: "user",
    });
    assert.equal(updateB.version, 3);

    // Wait slightly so update B finishes background embedding
    await new Promise((r) => setTimeout(r, 50));

    // Now release slow update A
    slowDeferred.resolve();

    // Wait for all embeddings to settle
    await store.waitForPendingEmbeddings();

    // Verification: Fast update B's embedding must remain active and valid
    const stats = await store.getEmbeddingStats(provider.modelName);
    assert.equal(stats.totalMemories, 1);
    assert.equal(stats.indexedValid, 1);
    assert.equal(stats.pendingTotal, 0);

    // Verify memories table has version 3
    const current = await store.get("status");
    assert.equal(current?.version, 3);
    assert.equal(current?.value, fastValue);

    await store.close();
  } finally {
    cleanup();
  }
});

test("write-path scenario 4: deletion during embedding does not leave orphan embedding or throw", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    const deleteTarget = "will be deleted soon";
    const deleteDeferred = new Deferred<void>();
    provider.deferredHooks.set(deleteTarget, deleteDeferred);

    // Start create
    const record = await store.create({
      kind: "fact",
      key: "temp-key",
      value: deleteTarget,
      provenance: "user",
    });

    // Delete record before embedding finishes
    const deleted = await store.delete("temp-key");
    assert.equal(deleted, true);

    // Release embedding
    deleteDeferred.resolve();

    await store.waitForPendingEmbeddings();

    // Verify record is gone and no orphan embedding exists
    const fetched = await store.get("temp-key");
    assert.equal(fetched, null);

    const stats = await store.getEmbeddingStats(provider.modelName);
    assert.equal(stats.totalMemories, 0);
    assert.equal(stats.indexedValid, 0);

    await store.close();
  } finally {
    cleanup();
  }
});

test("write-path scenario 5: privacy protection - sensitive content never reaches embedding provider", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    const sensitiveSecret = "sk-or-v1-abcdef0123456789abcdef0123456789";
    const sensitiveValue = `Here is my token: ${sensitiveSecret}`;

    const record = await store.create({
      kind: "fact",
      key: "secret-key",
      value: sensitiveValue,
      provenance: "user-explicit",
    });
    assert.ok(record.id);

    await store.waitForPendingEmbeddings();

    // Provider.embed MUST NEVER have been called for this sensitive value!
    assert.equal(provider.embedCalls.length, 0, "Provider must not receive sensitive text");

    // Memory is still preserved in SQLite
    const fetched = await store.get("secret-key");
    assert.ok(fetched);

    // But embedding remains unindexed and pending
    const stats = await store.getEmbeddingStats(provider.modelName);
    assert.equal(stats.indexedValid, 0);
    assert.equal(stats.unindexed, 1);

    await store.close();
  } finally {
    cleanup();
  }
});

test("write-path scenario 6: close during pending embedding prevents late writes and exits safely", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    const hangingValue = "hanging embed request";
    const hangingDeferred = new Deferred<void>();
    provider.deferredHooks.set(hangingValue, hangingDeferred);

    await store.create({
      kind: "fact",
      key: "hanging-key",
      value: hangingValue,
      provenance: "user",
    });

    // Close store while provider.embed is still hanging
    const closePromise = store.close({ timeoutMs: 50 });
    await closePromise;

    assert.equal(store.getState(), "closed");

    // Now resolve the hung provider call late
    hangingDeferred.resolve();
    await new Promise((r) => setTimeout(r, 50));

    // Attempting any write on closed store must throw
    await assert.rejects(
      () =>
        store.create({
          kind: "fact",
          key: "post-close",
          value: "should fail",
          provenance: "user",
        }),
      /closed/,
    );
  } finally {
    cleanup();
  }
});

test("write-path scenario 7: max concurrency limit strictly bounded to 2", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    provider.delayMs = 30; // 30ms per embedding call to observe concurrency

    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    // Create 4 memories in quick succession
    await Promise.all([
      store.create({ kind: "fact", key: "k1", value: "task 1 payload", provenance: "user" }),
      store.create({ kind: "fact", key: "k2", value: "task 2 payload", provenance: "user" }),
      store.create({ kind: "fact", key: "k3", value: "task 3 payload", provenance: "user" }),
      store.create({ kind: "fact", key: "k4", value: "task 4 payload", provenance: "user" }),
    ]);

    await store.waitForPendingEmbeddings();

    // Verify concurrency was strictly bounded by 2
    assert.ok(provider.maxConcurrent <= 2, `maxConcurrent was ${provider.maxConcurrent}, expected <= 2`);
    assert.ok(provider.maxConcurrent >= 1, "maxConcurrent should be at least 1");
    assert.equal(provider.embedCalls.length, 4);

    const stats = await store.getEmbeddingStats(provider.modelName);
    assert.equal(stats.indexedValid, 4);

    await store.close();
  } finally {
    cleanup();
  }
});

test("supplementary 1: concurrent double close returns the exact same shared closePromise", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    // Hold an embed task so close has something in flight to wait for
    const deferred = new Deferred<void>();
    provider.deferredHooks.set("double-close-test", deferred);

    await store.create({
      kind: "fact",
      key: "k-double",
      value: "double-close-test",
      provenance: "user",
    });

    // Call close() twice concurrently
    const p1 = store.close({ timeoutMs: 100 });
    const p2 = store.close({ timeoutMs: 100 });

    // Both callers must receive the exact same shared promise instance
    assert.equal(p1, p2, "Concurrent close() must return the same closePromise");

    // Release the hanging embed
    deferred.resolve();

    await Promise.all([p1, p2]);
    assert.equal(store.getState(), "closed");

    // Calling close() a third time when already closed returns immediately
    const p3 = store.close();
    await p3;
    assert.equal(store.getState(), "closed");
  } finally {
    cleanup();
  }
});

test("supplementary 2: close waits for an in-flight SQLite write that started before close", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    let writeStarted = false;
    let writeFinished = false;

    // Intercept saveEmbeddingsBatch to simulate a write delay
    const originalSaveBatch = store.saveEmbeddingsBatch.bind(store);
    store.saveEmbeddingsBatch = async (model, items) => {
      writeStarted = true;
      await new Promise((r) => setTimeout(r, 60)); // Write takes 60ms
      const result = await originalSaveBatch(model, items);
      writeFinished = true;
      return result;
    };

    // Trigger create -> launches background job
    await store.create({
      kind: "fact",
      key: "write-order",
      value: "write order value",
      provenance: "user",
    });

    // Wait until saveEmbeddingsBatch has entered
    while (!writeStarted) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Now call close while the write is actively running
    let closeResolved = false;
    const closePromise = store.close({ timeoutMs: 1000 }).then(() => {
      closeResolved = true;
    });

    // Close must NOT have resolved before the write finished
    assert.equal(closeResolved, false);

    await closePromise;

    // Proves the write finished BEFORE close completed
    assert.equal(writeFinished, true, "Write must finish before close resolves");
    assert.equal(closeResolved, true);
    assert.equal(store.getState(), "closed");
  } finally {
    cleanup();
  }
});

test("supplementary 3: close timeout expires before embed returns, and late embed does not write to database", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    const lateValue = "late returning value";
    const lateDeferred = new Deferred<void>();
    provider.deferredHooks.set(lateValue, lateDeferred);

    await store.create({
      kind: "fact",
      key: "late-key",
      value: lateValue,
      provenance: "user",
    });

    // Close with a very short timeout (30ms) while provider.embed is still pending
    await store.close({ timeoutMs: 30 });
    assert.equal(store.getState(), "closed");

    // Now let the hanging embed resolve late
    lateDeferred.resolve();
    await new Promise((r) => setTimeout(r, 60));

    // Open a separate read-only store to check SQLite disk state
    const readOnlyStore = await MemoryStore.openReadOnly(dbPath);
    const stats = await readOnlyStore.getEmbeddingStats(provider.modelName);

    // Assert that the late embed was NOT written to memory_embeddings
    assert.equal(stats.indexedValid, 0, "No embedding row must be created after close");
    assert.equal(stats.unindexed, 1, "Record must remain pending/unindexed");

    await readOnlyStore.close();
  } finally {
    cleanup();
  }
});

test("supplementary 4: createChatServices wires embeddingProvider to MemoryStore and powers background indexing", async () => {
  const { dbPath, cleanup } = createTempDb();
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = globalThis.fetch;

  process.env.OPENROUTER_API_KEY = "test-chat-integration-key";
  globalThis.fetch = async (_input, init) => {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Understood and remembered." } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const provider = new FakeEmbeddingProvider();

    // Call createChatServices passing embeddingProvider
    const services = await createChatServices({
      memoryPath: dbPath,
      embeddingProvider: provider,
      createProvider: () => OpenRouterProvider.fromEnv(),
    });

    // Verify memoryStore was returned and has the embedding provider
    assert.ok(services.memoryStore);
    assert.equal(services.memoryStore.getEmbeddingProvider(), provider);

    // Send a message that triggers explicit memory creation
    await services.conversationService.respond("/remember favorite-editor = Neovim");

    // Wait for background embeddings to finish
    await services.memoryStore.waitForPendingEmbeddings();

    // Verify embeddingProvider.embed was invoked for the saved memory
    assert.ok(provider.embedCalls.length >= 1);
    assert.ok(provider.embedCalls.some((call) => call.includes("Neovim")));

    // Verify stats in MemoryStore
    const stats = await services.memoryStore.getEmbeddingStats(provider.modelName);
    assert.equal(stats.indexedValid, 1);
    assert.equal(stats.pendingTotal, 0);

    await services.memoryStore.close();
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
    cleanup();
  }
});

test("critical lifecycle: active SQLite write is NEVER abandoned on close timeout, and second close waits for same promise", async () => {
  const { dbPath, cleanup } = createTempDb();
  try {
    const provider = new FakeEmbeddingProvider();
    const store = await MemoryStore.open(dbPath, { embeddingProvider: provider });

    const writeGate = new Deferred<void>();
    const writeEntered = new Deferred<void>();
    let writeFinished = false;

    // Deterministically intercept saveEmbeddingsBatch
    const originalSaveBatch = store.saveEmbeddingsBatch.bind(store);
    store.saveEmbeddingsBatch = async (model, items) => {
      writeEntered.resolve();
      // Block write deterministically until test releases writeGate
      await writeGate.promise;
      const res = await originalSaveBatch(model, items);
      writeFinished = true;
      return res;
    };

    // 1. Start memory creation -> triggers background embedding -> enters saveEmbeddingsBatch
    await store.create({
      kind: "fact",
      key: "critical-key",
      value: "deterministic write value",
      provenance: "user",
    });

    // Wait until SQLite write has actually entered and holds activeBackgroundWrites > 0
    await writeEntered.promise;

    // 2. Call close() with very short timeout (e.g. 10ms)
    let close1Resolved = false;
    let close2Resolved = false;

    const p1 = store.close({ timeoutMs: 10 });
    const p2 = store.close({ timeoutMs: 10 });

    // Prove that both calls share the EXACT same closePromise
    assert.equal(p1, p2, "Second close() must share the exact same closePromise");

    const close1Promise = p1.then(() => {
      close1Resolved = true;
    });
    const close2Promise = p2.then(() => {
      close2Resolved = true;
    });

    // 3. Wait for the 10ms timeout to definitely expire
    await new Promise((r) => setTimeout(r, 40));

    // 4. Verify that close() has NOT resolved, despite timeout expiration!
    assert.equal(close1Resolved, false, "close() must NOT resolve while SQLite write is still pending");
    assert.equal(close2Resolved, false, "second close() must NOT resolve while SQLite write is still pending");
    assert.equal(writeFinished, false);

    // 7. Verify state did NOT become 'closed' prematurely
    assert.equal(store.getState(), "closing", "Store state must remain 'closing' while write is in-flight");

    // 5. Allow SQLite write to finish
    writeGate.resolve();

    // 6. Verify close() completes only AFTER the write finishes
    await Promise.all([close1Promise, close2Promise]);

    assert.equal(writeFinished, true, "SQLite write must have finished");
    assert.equal(close1Resolved, true);
    assert.equal(close2Resolved, true);
    assert.equal(store.getState(), "closed", "State transitions to 'closed' only after write finishes");

    // Verify record in SQLite is validly indexed
    const readOnlyStore = await MemoryStore.openReadOnly(dbPath);
    const stats = await readOnlyStore.getEmbeddingStats(provider.modelName);
    assert.equal(stats.indexedValid, 1, "Embedding must be successfully written to database");
    await readOnlyStore.close();
  } finally {
    cleanup();
  }
});
