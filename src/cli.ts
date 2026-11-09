import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  EmbeddingConfigurationError,
  OllamaEmbeddingProvider,
  type EmbeddingProvider,
} from "./embedding";
import { MemoryStore, type EmbeddingStats } from "./memory";
import {
  DEFAULT_REINDEX_BATCH_SIZE,
  MAX_REINDEX_BATCH_SIZE,
  ReindexAbortedError,
  ReindexConfigurationError,
  ReindexServiceError,
  reindexMemories,
  resolveConfiguredModelIdentity,
  type ReindexStore,
} from "./reindex";

export interface CliReadOnlyStatsStore {
  getEmbeddingStats(model: string): Promise<EmbeddingStats>;
}

export interface CliDependencies {
  dbPath?: string;
  digest?: string;
  providerName?: string;
  modelName?: string;
  dimensions?: number;
  signal?: AbortSignal;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  createEmbeddingProvider?: () => EmbeddingProvider;
  openStore?: (filePath: string) => Promise<ReindexStore>;
  openReadOnlyStore?: (filePath: string) => Promise<CliReadOnlyStatsStore>;
}

interface ParsedCliArgs {
  command: "reindex" | "stats";
  batchSize?: number;
  dbPath?: string;
}

export function resolveDefaultCliDbPath(): string {
  return process.env.JARVIS_DB_PATH
    ? resolve(process.env.JARVIS_DB_PATH)
    : join(homedir(), ".jarvis", "jarvis.sqlite");
}

function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  if (argv.length === 0) {
    throw new ReindexConfigurationError(
      "Usage: jarvis-cli <reindex|stats> [--batch-size <1..50>] [--db <path>]",
    );
  }

  const commandRaw = argv[0]?.trim();
  if (commandRaw !== "reindex" && commandRaw !== "stats") {
    throw new ReindexConfigurationError(
      `Unknown command "${commandRaw ?? ""}". Expected "reindex" or "stats".`,
    );
  }

  let batchSize: number | undefined;
  let dbPath: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--db" || arg.startsWith("--db=")) {
      const value = arg === "--db" ? argv[++i] : arg.slice("--db=".length);
      if (!value || !value.trim()) {
        throw new ReindexConfigurationError("Flag --db requires a non-empty file path.");
      }
      dbPath = resolve(value.trim());
      continue;
    }

    if (arg === "--batch-size" || arg.startsWith("--batch-size=")) {
      if (commandRaw !== "reindex") {
        throw new ReindexConfigurationError(
          `Flag --batch-size is only supported for the "reindex" command.`,
        );
      }
      const rawValue =
        arg === "--batch-size" ? argv[++i] : arg.slice("--batch-size=".length);
      if (rawValue === undefined || !rawValue.trim()) {
        throw new ReindexConfigurationError(
          `Flag --batch-size requires an integer between 1 and ${MAX_REINDEX_BATCH_SIZE}.`,
        );
      }
      const parsed = Number(rawValue.trim());
      if (
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_REINDEX_BATCH_SIZE
      ) {
        throw new ReindexConfigurationError(
          `batchSize must be an integer between 1 and ${MAX_REINDEX_BATCH_SIZE}.`,
        );
      }
      batchSize = parsed;
      continue;
    }

    throw new ReindexConfigurationError(`Unsupported option "${arg}".`);
  }

  return {
    command: commandRaw,
    batchSize,
    dbPath,
  };
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const out = dependencies.stdout ?? ((line: string) => console.log(line));
  const err = dependencies.stderr ?? ((line: string) => console.error(line));

  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    err(
      error instanceof Error
        ? error.message
        : "Invalid command-line arguments.",
    );
    return 1;
  }

  const targetDbPath =
    parsed.dbPath ?? dependencies.dbPath ?? resolveDefaultCliDbPath();

  if (parsed.command === "stats") {
    let identityInfo: ReturnType<typeof resolveConfiguredModelIdentity>;
    try {
      identityInfo = resolveConfiguredModelIdentity({
        providerName: dependencies.providerName,
        modelName: dependencies.modelName,
        dimensions: dependencies.dimensions,
        digest: dependencies.digest,
      });
    } catch (error) {
      err(
        error instanceof Error
          ? `Identity configuration error: ${error.message}`
          : "Invalid embedding model identity configuration.",
      );
      return 1;
    }

    try {
      const openReadOnly =
        dependencies.openReadOnlyStore ??
        ((path: string) => MemoryStore.openReadOnly(path));
      const store = await openReadOnly(targetDbPath);
      const stats = await store.getEmbeddingStats(identityInfo.identity);

      out(`model: ${stats.activeModel}`);
      out(
        `digestPinnedInConfig: ${identityInfo.digestPinnedInConfig} (config-only; runtime Ollama weights are not verified)`,
      );
      out(`databaseExists: ${stats.databaseExists}`);
      out(`totalMemories: ${stats.totalMemories}`);
      out(`indexedValid: ${stats.indexedValid}`);
      out(`unindexed: ${stats.unindexed}`);
      out(`staleMismatched: ${stats.staleMismatched}`);
      out(`pendingTotal: ${stats.pendingTotal}`);
      out(`otherModelsCount: ${stats.otherModels.length}`);
      for (const other of stats.otherModels) {
        out(`otherModel[${other.model}]: ${other.count}`);
      }
      return 0;
    } catch {
      err("Failed to read embedding statistics from the memory store.");
      return 1;
    }
  }

  // Command: reindex
  let provider: EmbeddingProvider;
  try {
    provider = (
      dependencies.createEmbeddingProvider ??
      (() => OllamaEmbeddingProvider.fromEnv())
    )();
  } catch (error) {
    if (error instanceof EmbeddingConfigurationError) {
      err(`Configuration error: ${error.message}`);
    } else {
      err("Failed to initialize embedding provider configuration.");
    }
    return 1;
  }
  const effectiveBatchSize = parsed.batchSize ?? DEFAULT_REINDEX_BATCH_SIZE;
  let store: ReindexStore;
  try {
    const openStore =
      dependencies.openStore ?? ((path: string) => MemoryStore.open(path));
    store = await openStore(targetDbPath);
  } catch {
    err("Failed to open memory store for reindexing.");
    return 1;
  }

  try {
    const result = await reindexMemories(store, provider, {
      batchSize: effectiveBatchSize,
      signal: dependencies.signal,
      providerName: dependencies.providerName,
      digest: dependencies.digest,
      onProgress: (snapshot) => {
        out(
          `[batch ${snapshot.batchesCompleted}] scanned=${snapshot.scanned} written=${snapshot.written} skippedStale=${snapshot.skippedStale} skippedDeleted=${snapshot.skippedDeleted} failedRecords=${snapshot.failedRecords}`,
        );
      },
    });

    out(`model: ${result.modelIdentity}`);
    out(
      `digestPinnedInConfig: ${result.digestPinnedInConfig} (config-only; runtime Ollama weights are not verified)`,
    );
    out(
      `completed: batches=${result.batchesCompleted} scanned=${result.scanned} written=${result.written} skippedStale=${result.skippedStale} skippedDeleted=${result.skippedDeleted} skippedEmpty=${result.skippedEmpty} failedRecords=${result.failedRecords}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ReindexAbortedError) {
      const s = error.summary;
      err(
        `cancelled: batches=${s.batchesCompleted} scanned=${s.scanned} written=${s.written} skippedStale=${s.skippedStale} skippedDeleted=${s.skippedDeleted} failedRecords=${s.failedRecords}`,
      );
      return 130;
    }
    if (error instanceof ReindexConfigurationError) {
      err(`Configuration error: ${error.message}`);
      return 1;
    }
    if (error instanceof ReindexServiceError) {
      const s = error.summary;
      err(
        `error (${error.reason}): ${error.message} [committed: batches=${s.batchesCompleted} written=${s.written}]`,
      );
      return 1;
    }
    err("Reindexing failed due to an unexpected internal error.");
    return 1;
  }
}

if (require.main === module) {
  const controller = new AbortController();
  const handleSignal = (): void => {
    controller.abort();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  runCli(process.argv.slice(2), { signal: controller.signal })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error("Fatal CLI error.");
      process.exitCode = 1;
    })
    .finally(() => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    });
}
