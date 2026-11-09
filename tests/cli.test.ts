import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  EmbeddingConnectionError,
  type EmbeddingProvider,
} from "../src/embedding";
import { MemoryStore } from "../src/memory";

function createMockEmbeddingProvider(
  modelName = "bge-m3",
  dimensions = DEFAULT_EMBEDDING_DIMENSIONS,
  failAfter?: number,
): EmbeddingProvider {
  let count = 0;
  return {
    modelName,
    dimensions,
    async embed(): Promise<Float32Array> {
      count += 1;
      if (failAfter !== undefined && count > failAfter) {
        throw new EmbeddingConnectionError("Ollama unreachable");
      }
      const vec = new Float32Array(dimensions);
      vec.fill(0.25);
      return vec;
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}

function forbiddenProviderFactory(): EmbeddingProvider {
  throw new Error("createEmbeddingProvider must NEVER be called by stats");
}

test("stats uses openReadOnly: does not create missing paths, ignores live write locks, and never mutates disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-cli-readonly-"));
  try {
    // 1. Missing directory and missing DB file: stats must NOT create either.
    const missingDir = join(root, "nonexistent-subdir");
    const missingDb = join(missingDir, "missing.sqlite");
    const missingOut: string[] = [];
    const missingErr: string[] = [];

    const missingCode = await runCli(["stats", "--db", missingDb], {
      providerName: "ollama",
      digest: "",
      createEmbeddingProvider: forbiddenProviderFactory,
      stdout: (line) => missingOut.push(line),
      stderr: (line) => missingErr.push(line),
    });

    assert.equal(missingCode, 0);
    assert.deepEqual(missingErr, []);
    assert.equal(existsSync(missingDir), false);
    assert.equal(existsSync(missingDb), false);
    assert.equal(existsSync(`${missingDb}.lock`), false);
    assert.ok(missingOut.includes("databaseExists: false"));
    assert.ok(missingOut.includes("totalMemories: 0"));

    // 2. Existing DB with an active live .lock held AND 0o400 read-only file mode.
    const dbPath = join(root, "locked.sqlite");
    const store = await MemoryStore.open(dbPath);
    await store.create({
      kind: "fact",
      key: "fact-one",
      value: "First memory value",
      provenance: "cli test",
    });
    await store.create({
      kind: "fact",
      key: "fact-two",
      value: "Second memory value",
      provenance: "cli test",
    });

    // Verify openReadOnly rejects all write operations immediately before touching .lock
    const roStore = await MemoryStore.openReadOnly(dbPath);
    await assert.rejects(
      roStore.create({
        kind: "fact",
        key: "illegal-write",
        value: "blocked",
        provenance: "test",
      }),
      /Cannot perform write operation on a read-only MemoryStore/,
    );
    await assert.rejects(
      roStore.saveEmbeddingsBatch("ollama:bge-m3|dim=1024|norm=v1", []),
      /Cannot perform write operation on a read-only MemoryStore/,
    );
    assert.equal(existsSync(`${dbPath}.lock`), false);

    // Seed a live write lock owned by current PID so any write-lock acquisition would block & timeout
    const lockPath = `${dbPath}.lock`;
    const lockPayload = JSON.stringify({
      createdAt: Date.now(),
      pid: process.pid,
      token: "active-live-chat-writer",
    });
    writeFileSync(lockPath, lockPayload, { mode: 0o600 });
    chmodSync(dbPath, 0o400);
    const statBefore = statSync(dbPath);

    try {
      const out: string[] = [];
      const err: string[] = [];
      const startMs = Date.now();
      const exitCode = await runCli(["stats", "--db", dbPath], {
        providerName: "ollama",
        digest: "",
        createEmbeddingProvider: forbiddenProviderFactory,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      });
      const elapsedMs = Date.now() - startMs;

      assert.equal(exitCode, 0);
      assert.deepEqual(err, []);
      assert.ok(elapsedMs < 1_000, `stats should not wait on .lock, took ${elapsedMs}ms`);
      assert.ok(out.includes("databaseExists: true"));
      assert.ok(out.includes("totalMemories: 2"));
      assert.ok(out.includes("indexedValid: 0"));
      assert.ok(out.includes("unindexed: 2"));
      assert.ok(out.includes("pendingTotal: 2"));

      // Also verify real subprocess invocation (`node dist/src/cli.js stats --db ...`)
      const subStdout = execFileSync(
        process.execPath,
        [join(process.cwd(), "dist/src/cli.js"), "stats", "--db", dbPath],
        { encoding: "utf8" },
      );
      assert.match(subStdout, /totalMemories: 2/);
      assert.match(subStdout, /pendingTotal: 2/);

      const statAfter = statSync(dbPath);
      assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
      assert.equal(statAfter.size, statBefore.size);
      assert.equal(readFileSync(lockPath, "utf8"), lockPayload);
    } finally {
      chmodSync(dbPath, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reindex and stats share identical model identity without stats instantiating EmbeddingProvider, and never leak memory contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-cli-e2e-"));
  const dbPath = join(root, "cli.sqlite");
  const secretKey = `secret-key-${randomUUID()}`;
  const secretValue = `SECRET-VALUE-${randomUUID()}`;
  const secretProvenance = `SECRET-PROVENANCE-${randomUUID()}`;

  try {
    const store = await MemoryStore.open(dbPath);
    for (let i = 0; i < 3; i++) {
      await store.create({
        kind: "fact",
        key: `${secretKey}-${i}`,
        value: `${secretValue}-${i}`,
        provenance: secretProvenance,
      });
    }

    let providerFactoryCalls = 0;
    const reindexOut: string[] = [];
    const reindexErr: string[] = [];
    const code = await runCli(
      ["reindex", "--batch-size", "2", "--db", dbPath],
      {
        providerName: "ollama",
        digest: "sha256:fixed123",
        createEmbeddingProvider: () => {
          providerFactoryCalls += 1;
          return createMockEmbeddingProvider("bge-m3", DEFAULT_EMBEDDING_DIMENSIONS);
        },
        stdout: (line) => reindexOut.push(line),
        stderr: (line) => reindexErr.push(line),
      },
    );

    assert.equal(code, 0);
    assert.equal(providerFactoryCalls, 1);
    assert.deepEqual(reindexErr, []);
    const combinedReindex = reindexOut.join("\n");
    assert.match(combinedReindex, /model: ollama:bge-m3#sha256:fixed123\|dim=1024\|norm=v1/);
    assert.match(
      combinedReindex,
      /digestPinnedInConfig: true \(config-only; runtime Ollama weights are not verified\)/,
    );
    assert.match(combinedReindex, /completed: batches=2 scanned=3 written=3/);
    assert.equal(combinedReindex.includes(secretKey), false);
    assert.equal(combinedReindex.includes(secretValue), false);
    assert.equal(combinedReindex.includes(secretProvenance), false);

    // Stats with identical identity shows 3 valid, 0 pending, and NEVER calls createEmbeddingProvider
    const statsOut: string[] = [];
    const statsCode = await runCli(["stats", `--db=${dbPath}`], {
      providerName: "ollama",
      digest: "sha256:fixed123",
      createEmbeddingProvider: forbiddenProviderFactory,
      stdout: (line) => statsOut.push(line),
    });
    assert.equal(statsCode, 0);
    assert.equal(providerFactoryCalls, 1);
    const combinedStats = statsOut.join("\n");
    assert.match(combinedStats, /model: ollama:bge-m3#sha256:fixed123\|dim=1024\|norm=v1/);
    assert.match(combinedStats, /indexedValid: 3/);
    assert.match(combinedStats, /pendingTotal: 0/);
    assert.match(combinedStats, /otherModelsCount: 0/);
    assert.equal(combinedStats.includes(secretKey), false);
    assert.equal(combinedStats.includes(secretValue), false);

    // Stats with unpinned/different digest shows 0 valid for active model and 1 other model with 3 vectors
    const unpinnedOut: string[] = [];
    const unpinnedCode = await runCli(["stats", "--db", dbPath], {
      providerName: "ollama",
      digest: "",
      createEmbeddingProvider: forbiddenProviderFactory,
      stdout: (line) => unpinnedOut.push(line),
    });
    assert.equal(unpinnedCode, 0);
    const combinedUnpinned = unpinnedOut.join("\n");
    assert.match(combinedUnpinned, /digestPinnedInConfig: false/);
    assert.match(combinedUnpinned, /indexedValid: 0/);
    assert.match(combinedUnpinned, /unindexed: 3/);
    assert.match(combinedUnpinned, /otherModelsCount: 1/);
    assert.match(
      combinedUnpinned,
      /otherModel\[ollama:bge-m3#sha256:fixed123\|dim=1024\|norm=v1\]: 3/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli rejects both normal and dangling symlinks for --db in stats and reindex without creating side-car files", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-cli-symlink-"));
  try {
    const realDbPath = join(root, "real.sqlite");
    const store = await MemoryStore.open(realDbPath);
    await store.create({
      kind: "fact",
      key: "k1",
      value: "v1",
      provenance: "test",
    });

    const normalSymlink = join(root, "normal-link.sqlite");
    symlinkSync(realDbPath, normalSymlink);

    const missingTarget = join(root, "does-not-exist.sqlite");
    const danglingSymlink = join(root, "dangling-link.sqlite");
    symlinkSync(missingTarget, danglingSymlink);
    assert.equal(existsSync(danglingSymlink), false);

    for (const symlinkPath of [normalSymlink, danglingSymlink]) {
      for (const cmd of ["stats", "reindex"] as const) {
        const errLines: string[] = [];
        const code = await runCli([cmd, "--db", symlinkPath], {
          providerName: "ollama",
          digest: "",
          createEmbeddingProvider:
            cmd === "stats" ? forbiddenProviderFactory : () => createMockEmbeddingProvider(),
          stdout: () => undefined,
          stderr: (line) => errLines.push(line),
        });
        assert.equal(code, 1);
        assert.ok(errLines.length > 0);
        assert.equal(existsSync(`${symlinkPath}.lock`), false);
      }
    }
    assert.equal(existsSync(missingTarget), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli returns non-zero exit codes on invalid flags, service errors, and AbortSignal cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-cli-errors-"));
  const dbPath = join(root, "errors.sqlite");

  try {
    const store = await MemoryStore.open(dbPath);
    await store.create({
      kind: "fact",
      key: "k1",
      value: "CONFIDENTIAL-PAYLOAD-1",
      provenance: "test",
    });
    await store.create({
      kind: "fact",
      key: "k2",
      value: "CONFIDENTIAL-PAYLOAD-2",
      provenance: "test",
    });

    // Invalid CLI flags / commands -> exit code 1
    for (const badArgs of [
      [],
      ["unknown"],
      ["reindex", "--batch-size", "0"],
      ["reindex", "--batch-size=51"],
      ["stats", "--batch-size", "10"],
      ["reindex", "--db"],
      ["reindex", "--unknown-flag"],
    ]) {
      const errLines: string[] = [];
      const code = await runCli(badArgs, {
        dbPath,
        createEmbeddingProvider: () => createMockEmbeddingProvider(),
        stderr: (line) => errLines.push(line),
      });
      assert.equal(code, 1, `Expected exit code 1 for args: ${badArgs.join(" ")}`);
      assert.ok(errLines.length > 0);
    }

    // Service connection failure on 2nd item -> exit code 1, no secret payload leaked
    const svcErrLines: string[] = [];
    const svcCode = await runCli(["reindex", "--batch-size=1", "--db", dbPath], {
      providerName: "ollama",
      digest: "",
      createEmbeddingProvider: () => createMockEmbeddingProvider("bge-m3", 8, 1),
      stdout: () => undefined,
      stderr: (line) => svcErrLines.push(line),
    });
    assert.equal(svcCode, 1);
    assert.match(svcErrLines.join("\n"), /connection_error/);
    assert.match(svcErrLines.join("\n"), /committed: batches=1 written=1/);
    assert.equal(svcErrLines.join("\n").includes("CONFIDENTIAL-PAYLOAD"), false);

    // Pre-aborted signal -> exit code 130
    const controller = new AbortController();
    controller.abort();
    const abortErrLines: string[] = [];
    const abortCode = await runCli(["reindex", "--db", dbPath], {
      providerName: "ollama",
      digest: "",
      signal: controller.signal,
      createEmbeddingProvider: () => createMockEmbeddingProvider("bge-m3", 8),
      stdout: () => undefined,
      stderr: (line) => abortErrLines.push(line),
    });
    assert.equal(abortCode, 130);
    assert.match(abortErrLines.join("\n"), /cancelled:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
