import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import initSqlJs from "sql.js";
import {
  EmbeddingAPIError,
  EmbeddingConnectionError,
  EmbeddingResponseError,
  EmbeddingTimeoutError,
  type EmbeddingProvider,
} from "../src/embedding";
import { buildEmbeddingModelIdentity } from "../src/embedding_identity";
import {
  EMBEDDING_HASH_VERSION,
  MemoryStore,
  computeEmbeddingInputHash,
  serializeEmbedding,
  normalizeEmbeddingInput,
} from "../src/memory";
import {
  DEFAULT_REINDEX_BATCH_SIZE,
  MAX_REINDEX_BATCH_SIZE,
  ReindexAbortedError,
  ReindexConfigurationError,
  ReindexServiceError,
  reindexMemories,
  resolveConfiguredModelIdentity,
  resolveProviderModelIdentity,
  type ReindexProgressSnapshot,
} from "../src/reindex";

function makeTempDir(prefix: string): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `jarvis-${prefix}-`));
  const dbPath = join(dir, "test.sqlite");
  return {
    dir,
    dbPath,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeVector(seed: number, dimensions = 8): Float32Array {
  const vec = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    vec[i] = Math.fround((seed + 1) * 0.1 + i * 0.01);
  }
  return vec;
}

test("buildEmbeddingModelIdentity trims inputs, sorts extras, tracks digestPinnedInConfig, and rejects reserved delimiters", () => {
  const unpinned = buildEmbeddingModelIdentity({
    provider: "  ollama  ",
    modelName: "  bge-m3  ",
    dimensions: 1024,
    hashVersion: "  v1  ",
    digest: "   ",
    extra: {
      " zKey ": " valZ ",
      " aKey ": " valA ",
    },
  });

  assert.equal(unpinned.provider, "ollama");
  assert.equal(unpinned.modelName, "bge-m3");
  assert.equal(unpinned.hashVersion, EMBEDDING_HASH_VERSION);
  assert.equal(unpinned.digest, null);
  assert.equal(unpinned.digestPinnedInConfig, false);
  assert.equal(unpinned.identity, "ollama:bge-m3|dim=1024|norm=v1|aKey=valA|zKey=valZ");

  const pinned = buildEmbeddingModelIdentity({
    provider: "ollama",
    modelName: "bge-m3:v1.2",
    dimensions: 1024,
    hashVersion: "v1",
    digest: " sha256:790764642607 ",
  });

  assert.equal(pinned.digest, "sha256:790764642607");
  assert.equal(pinned.digestPinnedInConfig, true);
  assert.equal(
    pinned.identity,
    "ollama:bge-m3:v1.2#sha256:790764642607|dim=1024|norm=v1",
  );

  // Rejects reserved delimiters and invalid inputs
  assert.throws(
    () =>
      buildEmbeddingModelIdentity({
        provider: "ollama",
        modelName: "bge-m3",
        dimensions: 1024,
        hashVersion: "v1",
        extra: { "bad|key": "ok" },
      }),
    /reserved delimiters/,
  );
  assert.throws(
    () =>
      buildEmbeddingModelIdentity({
        provider: "ollama",
        modelName: "bge-m3",
        dimensions: 1024,
        hashVersion: "v1",
        extra: { key: "bad=value" },
      }),
    /reserved delimiters/,
  );
  assert.throws(
    () =>
      buildEmbeddingModelIdentity({
        provider: "ollama",
        modelName: "bge-m3",
        dimensions: 1024,
        hashVersion: "v1",
        extra: { key: "one", " key ": "two" },
      }),
    /Duplicate embedding identity extra key/,
  );
  assert.throws(
    () =>
      buildEmbeddingModelIdentity({
        provider: "ollama:injected",
        modelName: "bge-m3",
        dimensions: 1024,
        hashVersion: "v1",
      }),
    /reserved identity delimiters/,
  );
});

test("reindexMemories passes normalizeEmbeddingInput(record.value) to provider.embed instead of raw text", async () => {
  const { dbPath, cleanup } = makeTempDir("reindex-norm");
  try {
    const store = await MemoryStore.open(dbPath);
    const rawValue = "  مرحباً يا عالم\r\nCafe\u0301 🚀  \r\n";
    const expectedNormalized = normalizeEmbeddingInput(rawValue);
    assert.notEqual(rawValue, expectedNormalized);

    const created = await store.create({
      kind: "fact",
      key: "arabic-unicode-greeting",
      value: rawValue,
      provenance: "unit test",
    });

    const receivedTexts: string[] = [];
    const provider: EmbeddingProvider = {
      modelName: "bge-m3",
      dimensions: 8,
      async embed(text: string): Promise<Float32Array> {
        receivedTexts.push(text);
        return makeVector(1, 8);
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };

    const result = await reindexMemories(store, provider, { providerName: "ollama", digest: "" });
    assert.equal(result.written, 1);
    assert.deepEqual(receivedTexts, [expectedNormalized]);

    const stats = await store.getEmbeddingStats(result.modelIdentity);
    assert.equal(stats.totalMemories, 1);
    assert.equal(stats.indexedValid, 1);
    assert.equal(stats.pendingTotal, 0);

    // Running again is a no-op because content_hash matches value_hash
    const secondRun = await reindexMemories(store, provider, { providerName: "ollama", digest: "" });
    assert.equal(secondRun.scanned, 0);
    assert.equal(secondRun.written, 0);
    assert.equal(receivedTexts.length, 1);
    assert.equal(created.id.length > 0, true);
  } finally {
    cleanup();
  }
});

test("persists create() and update() to disk while provider.embed() is suspended and skips stale embedding optimistically", async () => {
  const { dir, dbPath, cleanup } = makeTempDir("reindex-nonblocking");
  try {
    const store = await MemoryStore.open(dbPath);
    const target = await store.create({
      kind: "project",
      key: "active-target",
      value: "Initial project specification",
      provenance: "initial",
    });
    const untouched = await store.create({
      kind: "fact",
      key: "untouched-fact",
      value: "Stable fact content",
      provenance: "initial",
    });

    let notifyEmbedEntered!: () => void;
    const embedEntered = new Promise<void>((resolve) => {
      notifyEmbedEntered = resolve;
    });

    let releaseFirstEmbed!: () => void;
    const firstEmbedGate = new Promise<void>((resolve) => {
      releaseFirstEmbed = resolve;
    });

    let callCount = 0;
    const provider: EmbeddingProvider = {
      modelName: "bge-m3",
      dimensions: 8,
      async embed(): Promise<Float32Array> {
        callCount += 1;
        if (callCount === 1) {
          notifyEmbedEntered();
          await firstEmbedGate;
        }
        return makeVector(callCount, 8);
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };

    const reindexPromise = reindexMemories(store, provider, {
      providerName: "ollama",
      digest: "",
      batchSize: 10,
    });

    await embedEntered;

    // 1. Verify NO write lock is held while provider.embed() is suspended.
    assert.equal(existsSync(`${dbPath}.lock`), false);

    // 2. Perform concurrent chat writes (create + update) while provider.embed() is suspended.
    const createdDuringEmbed = await store.create({
      kind: "goal",
      key: "created-during-embed",
      value: "Saved immediately while Ollama is busy",
      provenance: "live chat",
    });
    const updatedDuringEmbed = await store.update("active-target", target.version, {
      kind: "project",
      key: "active-target",
      value: "Updated specification during active embedding",
      provenance: "live chat correction",
    });

    assert.equal(existsSync(`${dbPath}.lock`), false);

    // 3. Open an independent read-only store directly from disk BEFORE releasing embed()
    //    to prove both create() and update() were durably written to the SQLite file on disk.
    const diskInspector = await MemoryStore.openReadOnly(dbPath);
    const persistedCreated = await diskInspector.get("created-during-embed");
    const persistedUpdated = await diskInspector.get("active-target");
    const persistedHistory = await diskInspector.history("active-target");

    assert.deepEqual(persistedCreated, createdDuringEmbed);
    assert.deepEqual(persistedUpdated, updatedDuringEmbed);
    assert.equal(persistedUpdated?.version, 2);
    assert.equal(persistedHistory.length, 2);

    // 4. Release suspended embed() and verify optimistic concurrency skips the mutated target.
    releaseFirstEmbed();
    const result = await reindexPromise;

    // Note: Depending on UUID ordering between target and untouched, one of the two in the initial
    // batch was updated before saveEmbeddingsBatch ran, so skippedStale === 1 and written >= 1.
    assert.equal(result.skippedStale, 1);
    assert.equal(result.skippedDeleted, 0);
    assert.equal(result.failedRecords, 0);

    // Verify the updated record was NOT overwritten and still lacks an embedding (or awaits next run),
    // while untouched-fact has a valid embedding.
    const afterReader = await MemoryStore.openReadOnly(dbPath);
    assert.equal(
      (await afterReader.get("active-target"))?.value,
      "Updated specification during active embedding",
    );
    assert.equal((await afterReader.get("untouched-fact"))?.id, untouched.id);

    const statsBeforeRetry = await afterReader.getEmbeddingStats(result.modelIdentity);
    assert.equal(statsBeforeRetry.totalMemories, 3);
    assert.ok(statsBeforeRetry.pendingTotal >= 1);

    // Next reindex pass cleanly indexes any remaining/updated records.
    const catchup = await reindexMemories(store, provider, {
      providerName: "ollama",
      digest: "",
    });
    assert.ok(catchup.written >= 1);
    const finalStats = await afterReader.getEmbeddingStats(result.modelIdentity);
    assert.equal(finalStats.indexedValid, 3);
    assert.equal(finalStats.pendingTotal, 0);

    // Ensure no leftover .lock or .pending files exist in temp directory.
    const leftovers = readdirSync(dir).filter(
      (name) => name.endsWith(".lock") || name.endsWith(".pending"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    cleanup();
  }
});

test("skips concurrently deleted records safely without foreign key failure or infinite loops", async () => {
  const { dbPath, cleanup } = makeTempDir("reindex-delete");
  try {
    const store = await MemoryStore.open(dbPath);
    await store.create({
      kind: "fact",
      key: "to-be-deleted",
      value: "Ephemeral fact",
      provenance: "test",
    });
    await store.create({
      kind: "fact",
      key: "kept-fact",
      value: "Permanent fact",
      provenance: "test",
    });

    let deleted = false;
    const provider: EmbeddingProvider = {
      modelName: "bge-m3",
      dimensions: 8,
      async embed(): Promise<Float32Array> {
        if (!deleted) {
          deleted = true;
          await store.delete("to-be-deleted");
        }
        return makeVector(3, 8);
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };

    const result = await reindexMemories(store, provider, {
      providerName: "ollama",
      digest: "",
    });
    assert.equal(result.scanned, 2);
    assert.equal(result.written, 1);
    assert.equal(result.skippedDeleted, 1);

    const stats = await store.getEmbeddingStats(result.modelIdentity);
    assert.equal(stats.totalMemories, 1);
    assert.equal(stats.indexedValid, 1);
    assert.equal(stats.pendingTotal, 0);
  } finally {
    cleanup();
  }
});

test("enforces batchSize bounds (default 25, max 50) and reports batch progress accurately", async () => {
  const { dbPath, cleanup } = makeTempDir("reindex-batches");
  try {
    const store = await MemoryStore.open(dbPath);
    assert.equal(DEFAULT_REINDEX_BATCH_SIZE, 25);
    assert.equal(MAX_REINDEX_BATCH_SIZE, 50);

    let embedCalls = 0;
    const provider: EmbeddingProvider = {
      modelName: "bge-m3",
      dimensions: 8,
      async embed(): Promise<Float32Array> {
        embedCalls += 1;
        return makeVector(embedCalls, 8);
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };

    for (const invalidBatchSize of [0, -1, 51, 100, 2.5, Number.NaN]) {
      await assert.rejects(
        reindexMemories(store, provider, { batchSize: invalidBatchSize }),
        ReindexConfigurationError,
      );
    }
    assert.equal(embedCalls, 0);

    for (let i = 0; i < 60; i++) {
      await store.create({
        kind: "fact",
        key: `item-${String(i).padStart(3, "0")}`,
        value: `Memory payload number ${i}`,
        provenance: "batch test",
      });
    }

    const snapshots: ReindexProgressSnapshot[] = [];
    const result = await reindexMemories(store, provider, {
      providerName: "ollama",
      digest: "",
      onProgress: (snap) => snapshots.push(snap),
    });

    assert.equal(result.batchesCompleted, 3);
    assert.equal(result.scanned, 60);
    assert.equal(result.written, 60);
    assert.deepEqual(
      snapshots.map((s) => s.written),
      [25, 50, 60],
    );
  } finally {
    cleanup();
  }
});

test("separates skippable record errors from run-stopping service errors without leaking sensitive content", async () => {
  const { dbPath, cleanup } = makeTempDir("reindex-errors");
  const secretKey = `secret-key-${randomUUID()}`;
  const secretValue = `SUPER-SECRET-TOKEN-${randomUUID()}`;
  const secretProvenance = `PRIVATE-SOURCE-${randomUUID()}`;

  try {
    const store = await MemoryStore.open(dbPath);
    await store.create({
      kind: "fact",
      key: "01-bad-413",
      value: `${secretValue}-too-long`,
      provenance: secretProvenance,
    });
    await store.create({
      kind: "fact",
      key: "02-bad-nan",
      value: `${secretValue}-nan`,
      provenance: secretProvenance,
    });
    await store.create({
      kind: "fact",
      key: secretKey,
      value: `${secretValue}-healthy`,
      provenance: secretProvenance,
    });

    // Inject a legacy whitespace-only row directly via sql.js to verify empty-normalized record skip
    const SQL = await initSqlJs();
    const rawDb = new SQL.Database(
      new Uint8Array(await import("node:fs").then((fs) => fs.readFileSync(dbPath))),
    );
    try {
      rawDb.run(
        "INSERT INTO memories (id, kind, key, value, provenance, version, value_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "00-empty-legacy",
          "fact",
          "legacy-whitespace",
          "   \r\n  ",
          secretProvenance,
          1,
          computeEmbeddingInputHash(""),
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
      const fs = await import("node:fs");
      fs.writeFileSync(dbPath, Buffer.from(rawDb.export()));
    } finally {
      rawDb.close();
    }

    const recordErrorProvider: EmbeddingProvider = {
      modelName: "bge-m3",
      dimensions: 8,
      async embed(text: string): Promise<Float32Array> {
        if (text.endsWith("-too-long")) {
          throw new EmbeddingAPIError(`Payload rejected: ${text}`, { status: 413 });
        }
        if (text.endsWith("-nan")) {
          const bad = makeVector(1, 8);
          bad[3] = Number.NaN;
          return bad;
        }
        return makeVector(7, 8);
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };

    const recordResult = await reindexMemories(store, recordErrorProvider, {
      providerName: "ollama",
      digest: "",
      batchSize: 10,
    });

    assert.equal(recordResult.written, 1);
    assert.equal(recordResult.skippedEmpty, 1);
    assert.equal(recordResult.failedRecords, 3);
    assert.equal(recordResult.recordErrorCounts.empty_normalized_value, 1);
    assert.equal(recordResult.recordErrorCounts.http_413, 1);
    assert.equal(recordResult.recordErrorCounts.non_finite_vector, 1);

    // Also verify OllamaEmbeddingProvider's EmbeddingResponseError("... invalid numeric value ...") is treated as record-scoped
    const responseNanProvider: EmbeddingProvider = {
      modelName: "bge-m3",
      dimensions: 8,
      async embed(text: string): Promise<Float32Array> {
        if (text.endsWith("-nan")) {
          throw new EmbeddingResponseError(
            "Embedding vector contains invalid numeric value at index 2.",
          );
        }
        if (text.endsWith("-too-long")) {
          throw new EmbeddingAPIError("Unprocessable", { status: 422 });
        }
        return makeVector(8, 8);
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };

    const secondPass = await reindexMemories(store, responseNanProvider, {
      providerName: "ollama",
      digest: "",
    });
    assert.equal(secondPass.recordErrorCounts.non_finite_vector, 1);
    assert.equal(secondPass.recordErrorCounts.http_422, 1);

    // Now test transient/service errors (Connection / Timeout / 503): stops run after preserving committed batch 1
    const { dbPath: serviceDbPath, cleanup: cleanupServiceDb } = makeTempDir("reindex-service-err");
    try {
      const serviceStore = await MemoryStore.open(serviceDbPath);
      for (let i = 0; i < 6; i++) {
        await serviceStore.create({
          kind: "fact",
          key: `svc-${i}-${secretKey}`,
          value: `${secretValue}-record-${i}`,
          provenance: secretProvenance,
        });
      }

      let calls = 0;
      let failureMode: "timeout" | "503" | "connection" | "none" = "timeout";
      const flakyProvider: EmbeddingProvider = {
        modelName: "bge-m3",
        dimensions: 8,
        async embed(text: string): Promise<Float32Array> {
          calls += 1;
          if (calls === 4 && failureMode !== "none") {
            if (failureMode === "timeout") {
              throw new EmbeddingTimeoutError(`Timed out on ${text}`);
            }
            if (failureMode === "503") {
              throw new EmbeddingAPIError(`Server overloaded on ${text}`, { status: 503 });
            }
            throw new EmbeddingConnectionError(`Offline on ${text}`);
          }
          return makeVector(calls, 8);
        },
        async healthCheck(): Promise<boolean> {
          return true;
        },
      };

      await assert.rejects(
        reindexMemories(serviceStore, flakyProvider, {
          providerName: "ollama",
          digest: "",
          batchSize: 3,
        }),
        (err: unknown) => {
          assert.ok(err instanceof ReindexServiceError);
          assert.equal(err.reason, "timeout");
          assert.equal(err.summary.batchesCompleted, 1);
          assert.equal(err.summary.written, 3);
          const serialized = `${err.message} ${JSON.stringify(err.summary)}`;
          assert.equal(serialized.includes(secretKey), false);
          assert.equal(serialized.includes(secretValue), false);
          assert.equal(serialized.includes(secretProvenance), false);
          return true;
        },
      );

      // Verify first batch of 3 is durably persisted on disk, and resuming finishes remaining 3
      const identity = resolveProviderModelIdentity(flakyProvider, {
        providerName: "ollama",
        digest: "",
      }).identity;
      const midStats = await serviceStore.getEmbeddingStats(identity);
      assert.equal(midStats.indexedValid, 3);
      assert.equal(midStats.pendingTotal, 3);

      calls = 3;
      failureMode = "503";
      await assert.rejects(
        reindexMemories(serviceStore, flakyProvider, {
          providerName: "ollama",
          digest: "",
          batchSize: 3,
        }),
        (err: unknown) => {
          assert.ok(err instanceof ReindexServiceError);
          assert.equal(err.reason, "http_503");
          assert.equal(err.status, 503);
          assert.equal(err.message.includes(secretValue), false);
          return true;
        },
      );

      failureMode = "none";
      const resumed = await reindexMemories(serviceStore, flakyProvider, {
        providerName: "ollama",
        digest: "",
        batchSize: 3,
      });
      assert.equal(resumed.written, 3);

      const finalStats = await serviceStore.getEmbeddingStats(identity);
      assert.equal(finalStats.indexedValid, 6);
      assert.equal(finalStats.pendingTotal, 0);
    } finally {
      cleanupServiceDb();
    }
  } finally {
    cleanup();
  }
});

test("cancels cleanly via AbortSignal at cooperative boundary after in-flight provider.embed() settles", async () => {
  const { dir, dbPath, cleanup } = makeTempDir("reindex-abort");
  try {
    const store = await MemoryStore.open(dbPath);
    for (let i = 0; i < 5; i++) {
      await store.create({
        kind: "fact",
        key: `abort-item-${i}`,
        value: `Abort test value ${i}`,
        provenance: "test",
      });
    }

    const controller = new AbortController();
    let embedInvocations = 0;
    let notifyThirdEmbedInFlight!: () => void;
    const thirdEmbedInFlight = new Promise<void>((resolve) => {
      notifyThirdEmbedInFlight = resolve;
    });
    let resolveThirdEmbed!: () => void;
    const thirdEmbedGate = new Promise<void>((resolve) => {
      resolveThirdEmbed = resolve;
    });

    const provider: EmbeddingProvider = {
      modelName: "bge-m3",
      dimensions: 8,
      async embed(): Promise<Float32Array> {
        embedInvocations += 1;
        if (embedInvocations === 3) {
          notifyThirdEmbedInFlight();
          await thirdEmbedGate;
        }
        return makeVector(embedInvocations, 8);
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };

    const reindexPromise = reindexMemories(store, provider, {
      providerName: "ollama",
      digest: "",
      batchSize: 2,
      signal: controller.signal,
    });

    // Wait until the 3rd embed() (1st record of batch #2) is actively in-flight
    await thirdEmbedInFlight;

    // Trigger abort while provider.embed() is suspended in-flight.
    // Because EmbeddingProvider.embed() does not accept AbortSignal, reindexMemories
    // waits for the in-flight embed() to settle, then immediately aborts before calling
    // embed() for the 4th record or committing batch #2.
    controller.abort();
    resolveThirdEmbed();

    await assert.rejects(
      reindexPromise,
      (err: unknown) => {
        assert.ok(err instanceof ReindexAbortedError);
        assert.equal(err.summary.batchesCompleted, 1);
        assert.equal(err.summary.written, 2);
        return true;
      },
    );

    // Exactly 3 invocations: batch #1 (2 records) + the 1 in-flight record in batch #2.
    // The 4th record was never embedded, and batch #2 was never saved.
    assert.equal(embedInvocations, 3);
    const identity = resolveConfiguredModelIdentity({
      providerName: "ollama",
      modelName: "bge-m3",
      dimensions: 8,
      digest: "",
    }).identity;
    const stats = await store.getEmbeddingStats(identity);
    assert.equal(stats.indexedValid, 2);
    assert.equal(stats.pendingTotal, 3);

    const leftovers = readdirSync(dir).filter(
      (name) => name.endsWith(".lock") || name.endsWith(".pending"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    cleanup();
  }
});

test("buildEmbeddingModelIdentity uses locale-independent code-unit sort across mixed case, digits, ASCII, and Unicode", () => {
  // In UTF-16 code-unit order:
  // "0" (0x30) < "9" (0x39) < "A" (0x41) < "B" (0x42) < "Z" (0x5A) < "_" (0x5F) < "a" (0x61) < "b" (0x62) < "z" (0x7A) < "ä" (0xE4) < "Ω" (0x3A9) < "آ" (0x622)
  // Notably, localeCompare in standard English locales orders "a" before "B", whereas code-unit order strictly orders "B" before "a".
  const orderedKeys = ["0key", "9key", "Akey", "Bkey", "Zkey", "_key", "akey", "bkey", "zkey", "äkey", "Ωkey", "آkey"];

  const permutation1: Record<string, string> = {};
  for (const k of [...orderedKeys].reverse()) {
    permutation1[k] = `v_${k}`;
  }

  const permutation2: Record<string, string> = {};
  for (const k of ["akey", "Bkey", "آkey", "0key", "_key", "äkey", "Zkey", "bkey", "9key", "Akey", "Ωkey", "zkey"]) {
    permutation2[k] = `v_${k}`;
  }

  const id1 = buildEmbeddingModelIdentity({
    provider: "ollama",
    modelName: "bge-m3",
    dimensions: 1024,
    hashVersion: "v1",
    extra: permutation1,
  });

  const id2 = buildEmbeddingModelIdentity({
    provider: "ollama",
    modelName: "bge-m3",
    dimensions: 1024,
    hashVersion: "v1",
    extra: permutation2,
  });

  assert.equal(id1.identity, id2.identity);
  const expectedExtraSegment = orderedKeys.map((k) => `${k}=v_${k}`).join("|");
  assert.equal(id1.identity, `ollama:bge-m3|dim=1024|norm=v1|${expectedExtraSegment}`);

  // Also verify resolveConfiguredModelIdentity matches resolveProviderModelIdentity without a provider instance
  const dummyProvider: EmbeddingProvider = {
    modelName: "bge-m3",
    dimensions: 1024,
    async embed(): Promise<Float32Array> {
      return new Float32Array(1024);
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
  const fromConfig = resolveConfiguredModelIdentity({
    providerName: "ollama",
    modelName: "bge-m3",
    dimensions: 1024,
    digest: "sha256:abc",
    extra: permutation1,
  });
  const fromProvider = resolveProviderModelIdentity(dummyProvider, {
    providerName: "ollama",
    digest: "sha256:abc",
    extra: permutation2,
  });
  assert.deepEqual(fromConfig, fromProvider);
});

test("listPendingEmbeddings and getEmbeddingStats handle missing value_hash column even when memory_embeddings exists", async () => {
  const { dbPath, cleanup } = makeTempDir("legacy-no-value-hash");
  const modelIdentity = "ollama:bge-m3|dim=8|norm=v1";
  const val1 = "Legacy memory with existing embedding";
  const val2 = "Legacy memory without embedding";
  try {
    // Construct a SQLite DB where both memories (WITHOUT value_hash) and memory_embeddings exist,
    // and one memory row already has an embedding in memory_embeddings.
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    try {
      db.run(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          provenance TEXT NOT NULL,
          version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE memory_embeddings (
          memory_id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          embedding BLOB NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      const now = new Date().toISOString();
      db.run(
        "INSERT INTO memories (id, kind, key, value, provenance, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ["m-1", "fact", "legacy-1", val1, "legacy", 1, now, now],
      );
      db.run(
        "INSERT INTO memories (id, kind, key, value, provenance, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ["m-2", "fact", "legacy-2", val2, "legacy", 1, now, now],
      );

      // Even if content_hash in memory_embeddings matches what computeEmbeddingInputHash(val1) would produce,
      // because memories.value_hash column is absent on disk, it must NOT be counted as indexedValid!
      db.run(
        "INSERT INTO memory_embeddings (memory_id, model, dimensions, content_hash, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          "m-1",
          modelIdentity,
          8,
          computeEmbeddingInputHash(val1),
          serializeEmbedding(makeVector(1, 8)),
          now,
        ],
      );

      writeFileSync(dbPath, Buffer.from(db.export()));
    } finally {
      db.close();
    }

    const roStore = await MemoryStore.openReadOnly(dbPath);
    const pending = await roStore.listPendingEmbeddings(modelIdentity, 10);
    assert.equal(pending.length, 2);
    assert.deepEqual(
      pending.map((p) => ({ id: p.id, value: p.value, valueHash: p.valueHash })),
      [
        {
          id: "m-1",
          value: "Legacy memory with existing embedding",
          valueHash: computeEmbeddingInputHash(val1),
        },
        {
          id: "m-2",
          value: "Legacy memory without embedding",
          valueHash: computeEmbeddingInputHash(val2),
        },
      ],
    );

    // Cursor pagination works cleanly when value_hash column is missing
    const page1 = await roStore.listPendingEmbeddings(modelIdentity, 1);
    const page2 = await roStore.listPendingEmbeddings(modelIdentity, 1, page1[0].id);
    assert.equal(page1.length, 1);
    assert.equal(page1[0].id, "m-1");
    assert.equal(page2.length, 1);
    assert.equal(page2[0].id, "m-2");

    const stats = await roStore.getEmbeddingStats(modelIdentity);
    assert.equal(stats.databaseExists, true);
    assert.equal(stats.totalMemories, 2);
    assert.equal(stats.indexedValid, 0);
    assert.equal(stats.staleMismatched, 1);
    assert.equal(stats.unindexed, 1);
    assert.equal(stats.pendingTotal, 2);
    assert.equal(stats.indexedValid + stats.staleMismatched + stats.unindexed, stats.totalMemories);
    assert.equal(stats.pendingTotal, pending.length);
  } finally {
    cleanup();
  }
});

test("listPendingEmbeddings and getEmbeddingStats treat NULL, empty, and whitespace value_hash as pending even when an embedding row exists", async () => {
  const { dbPath, cleanup } = makeTempDir("null-empty-value-hash");
  const modelIdentity = "ollama:bge-m3|dim=8|norm=v1";
  try {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    try {
      // Simulate a schema where value_hash column exists (e.g., ALTER TABLE memories ADD COLUMN value_hash TEXT)
      // so rows may contain NULL, '', '   ', or a valid SHA-256 hex digest.
      db.run(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          provenance TEXT NOT NULL,
          version INTEGER NOT NULL,
          value_hash TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE memory_embeddings (
          memory_id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          content_hash TEXT,
          embedding BLOB NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      const now = new Date().toISOString();
      const validValue = "Properly hashed memory";
      const validHash = computeEmbeddingInputHash(validValue);
      const dummyBlob = serializeEmbedding(makeVector(1, 8));

      // 1. value_hash = NULL, no embedding -> unindexed
      db.run(
        "INSERT INTO memories VALUES (?, 'fact', 'k1', 'v1', 'p', 1, NULL, ?, ?)",
        ["row-1-null-unindexed", now, now],
      );
      // 2. value_hash = NULL, WITH embedding -> staleMismatched (must NOT be dropped by SQL NULL comparison!)
      db.run(
        "INSERT INTO memories VALUES (?, 'fact', 'k2', 'v2', 'p', 1, NULL, ?, ?)",
        ["row-2-null-with-emb", now, now],
      );
      db.run(
        "INSERT INTO memory_embeddings VALUES (?, ?, 8, ?, ?, ?)",
        ["row-2-null-with-emb", modelIdentity, computeEmbeddingInputHash("v2"), dummyBlob, now],
      );

      // 3. value_hash = '', no embedding -> unindexed
      db.run(
        "INSERT INTO memories VALUES (?, 'fact', 'k3', 'v3', 'p', 1, '', ?, ?)",
        ["row-3-empty-unindexed", now, now],
      );
      // 4. value_hash = '', WITH embedding whose content_hash is also '' -> staleMismatched (must NOT be indexedValid!)
      db.run(
        "INSERT INTO memories VALUES (?, 'fact', 'k4', 'v4', 'p', 1, '', ?, ?)",
        ["row-4-empty-with-emb", now, now],
      );
      db.run(
        "INSERT INTO memory_embeddings VALUES (?, ?, 8, '', ?, ?)",
        ["row-4-empty-with-emb", modelIdentity, dummyBlob, now],
      );

      // 5. value_hash = '   ', WITH embedding whose content_hash is '   ' -> staleMismatched
      db.run(
        "INSERT INTO memories VALUES (?, 'fact', 'k5', 'v5', 'p', 1, '   ', ?, ?)",
        ["row-5-ws-with-emb", now, now],
      );
      db.run(
        "INSERT INTO memory_embeddings VALUES (?, ?, 8, '   ', ?, ?)",
        ["row-5-ws-with-emb", modelIdentity, dummyBlob, now],
      );

      // 6. Valid value_hash, WITH embedding whose content_hash is NULL -> staleMismatched
      db.run(
        "INSERT INTO memories VALUES (?, 'fact', 'k6', 'v6', 'p', 1, ?, ?, ?)",
        ["row-6-null-content-hash", computeEmbeddingInputHash("v6"), now, now],
      );
      db.run(
        "INSERT INTO memory_embeddings VALUES (?, ?, 8, NULL, ?, ?)",
        ["row-6-null-content-hash", modelIdentity, dummyBlob, now],
      );

      // 7. Valid value_hash, WITH matching non-empty content_hash -> indexedValid
      db.run(
        "INSERT INTO memories VALUES (?, 'fact', 'k7', ?, 'p', 1, ?, ?, ?)",
        ["row-7-valid", validValue, validHash, now, now],
      );
      db.run(
        "INSERT INTO memory_embeddings VALUES (?, ?, 8, ?, ?, ?)",
        ["row-7-valid", modelIdentity, validHash, dummyBlob, now],
      );

      writeFileSync(dbPath, Buffer.from(db.export()));
    } finally {
      db.close();
    }

    const roStore = await MemoryStore.openReadOnly(dbPath);
    const pending = await roStore.listPendingEmbeddings(modelIdentity, 20);
    assert.deepEqual(
      pending.map((p) => p.id),
      [
        "row-1-null-unindexed",
        "row-2-null-with-emb",
        "row-3-empty-unindexed",
        "row-4-empty-with-emb",
        "row-5-ws-with-emb",
        "row-6-null-content-hash",
      ],
    );

    const stats = await roStore.getEmbeddingStats(modelIdentity);
    assert.equal(stats.totalMemories, 7);
    assert.equal(stats.indexedValid, 1);
    assert.equal(stats.unindexed, 2);
    assert.equal(stats.staleMismatched, 4);
    assert.equal(stats.pendingTotal, 6);
    assert.equal(stats.indexedValid + stats.staleMismatched + stats.unindexed, stats.totalMemories);
    assert.equal(stats.pendingTotal, pending.length);
  } finally {
    cleanup();
  }
});

test("rejects both normal symlinks and dangling symlinks across open, openReadOnly, listPendingEmbeddings, and getEmbeddingStats", async () => {
  const { dir, dbPath, cleanup } = makeTempDir("symlink-guard");
  try {
    const store = await MemoryStore.open(dbPath);
    await store.create({
      kind: "fact",
      key: "safe-key",
      value: "Safe value",
      provenance: "test",
    });
    const statBefore = statSync(dbPath);
    const bytesBefore = readFileSync(dbPath);

    // 1. Normal symlink pointing to an existing SQLite DB file
    const normalSymlinkPath = join(dir, "normal-symlink.sqlite");
    symlinkSync(dbPath, normalSymlinkPath);
    assert.equal(existsSync(normalSymlinkPath), true);

    await assert.rejects(
      MemoryStore.open(normalSymlinkPath),
      /SQLite database path must not be a symbolic link/,
    );
    await assert.rejects(
      MemoryStore.openReadOnly(normalSymlinkPath),
      /SQLite database path must not be a symbolic link/,
    );
    assert.equal(existsSync(`${normalSymlinkPath}.lock`), false);

    // Target file was not modified
    assert.equal(statSync(dbPath).mtimeMs, statBefore.mtimeMs);
    assert.deepEqual(readFileSync(dbPath), bytesBefore);

    // 2. Dangling symlink pointing to a non-existent target file (existsSync returns false!)
    const missingTargetPath = join(dir, "nonexistent-target.sqlite");
    const danglingSymlinkPath = join(dir, "dangling-symlink.sqlite");
    symlinkSync(missingTargetPath, danglingSymlinkPath);
    assert.equal(existsSync(danglingSymlinkPath), false);

    await assert.rejects(
      MemoryStore.open(danglingSymlinkPath),
      /SQLite database path must not be a symbolic link/,
    );
    await assert.rejects(
      MemoryStore.openReadOnly(danglingSymlinkPath),
      /SQLite database path must not be a symbolic link/,
    );
    assert.equal(existsSync(missingTargetPath), false);
    assert.equal(existsSync(`${danglingSymlinkPath}.lock`), false);

    // 3. If dbPath is replaced with a dangling symlink after openReadOnly, read methods still reject it
    const roStore = await MemoryStore.openReadOnly(dbPath);
    unlinkSync(dbPath);
    symlinkSync(missingTargetPath, dbPath);
    assert.equal(existsSync(dbPath), false);

    await assert.rejects(
      roStore.listPendingEmbeddings("ollama:bge-m3|dim=8|norm=v1", 10),
      /SQLite database path must not be a symbolic link/,
    );
    await assert.rejects(
      roStore.getEmbeddingStats("ollama:bge-m3|dim=8|norm=v1"),
      /SQLite database path must not be a symbolic link/,
    );
  } finally {
    cleanup();
  }
});

test("M-3 regression: openReadOnly safely handles missing files and missing tables across all read methods and rejects all write methods immediately", async () => {
  const { dir, cleanup } = makeTempDir("readonly-completeness");
  try {
    // 1. Non-existent database path
    const missingDbPath = join(dir, "missing.sqlite");
    const roMissing = await MemoryStore.openReadOnly(missingDbPath);
    assert.equal(await roMissing.get("any-key"), null);
    assert.deepEqual(await roMissing.list(), []);
    assert.deepEqual(await roMissing.search("query"), []);
    assert.deepEqual(await roMissing.history("any-key"), []);
    assert.equal(await roMissing.getTask("any-task"), null);
    assert.deepEqual(await roMissing.listTaskEvents("any-task"), []);
    assert.equal(existsSync(missingDbPath), false);

    // 2. Existing SQLite file with no tables created yet
    const emptySchemaDbPath = join(dir, "empty-schema.sqlite");
    const SQL = await initSqlJs();
    const rawDb = new SQL.Database();
    try {
      rawDb.run("CREATE TABLE dummy_unrelated (id TEXT PRIMARY KEY);");
      writeFileSync(emptySchemaDbPath, Buffer.from(rawDb.export()));
    } finally {
      rawDb.close();
    }

    const roEmptySchema = await MemoryStore.openReadOnly(emptySchemaDbPath);
    assert.equal(await roEmptySchema.get("any-key"), null);
    assert.deepEqual(await roEmptySchema.list(), []);
    assert.deepEqual(await roEmptySchema.search("query"), []);
    assert.deepEqual(await roEmptySchema.history("any-key"), []);
    assert.equal(await roEmptySchema.getTask("any-task"), null);
    assert.deepEqual(await roEmptySchema.listTaskEvents("any-task"), []);

    // 3. Immediate rejection of all write methods on read-only store
    const writeErrorPattern = /Cannot perform write operation on a read-only MemoryStore/;
    await assert.rejects(
      roMissing.create({ kind: "fact", key: "k", value: "v", provenance: "p" }),
      writeErrorPattern,
    );
    await assert.rejects(
      roMissing.update("k", 1, { kind: "fact", key: "k", value: "v2", provenance: "p" }),
      writeErrorPattern,
    );
    await assert.rejects(roMissing.delete("k"), writeErrorPattern);
    await assert.rejects(
      roMissing.createTask({ title: "t", status: "pending" }),
      writeErrorPattern,
    );
    await assert.rejects(roMissing.updateTask("id", { title: "t2" }), writeErrorPattern);
    await assert.rejects(
      roMissing.addTaskEvent({ taskId: "id", eventType: "note", content: "c" }),
      writeErrorPattern,
    );
    await assert.rejects(
      roMissing.saveEmbeddingsBatch("ollama:bge-m3|dim=8|norm=v1", []),
      writeErrorPattern,
    );
    assert.equal(existsSync(missingDbPath), false);
  } finally {
    cleanup();
  }
});

test("I-1 regression: public barrel index exports Phase 1, Phase 2.1, and Phase 2.2 APIs cleanly", async () => {
  const publicApi = await import("../src/index");
  assert.equal(typeof publicApi.MemoryStore, "function");
  assert.equal(typeof publicApi.OllamaEmbeddingProvider, "function");
  assert.equal(typeof publicApi.buildEmbeddingModelIdentity, "function");
  assert.equal(typeof publicApi.reindexMemories, "function");
  assert.equal(typeof publicApi.TaskService, "function");
  assert.equal(typeof publicApi.ConversationService, "function");
  assert.equal(typeof publicApi.containsSensitiveContent, "function");
});
