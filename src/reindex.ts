import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingAPIError,
  EmbeddingConfigurationError,
  EmbeddingConnectionError,
  EmbeddingResponseError,
  EmbeddingTimeoutError,
  OllamaEmbeddingProvider,
  type EmbeddingOptions,
  type EmbeddingProvider,
} from "./embedding";
import {
  buildEmbeddingModelIdentity,
  type ResolvedEmbeddingModelIdentity,
} from "./embedding_identity";
import {
  EMBEDDING_HASH_VERSION,
  MAX_EMBEDDING_BATCH_SIZE,
  computeEmbeddingInputHash,
  normalizeEmbeddingInput,
  type PendingEmbeddingRecord,
  type PreparedEmbeddingItem,
  type SaveEmbeddingsBatchResult,
} from "./memory";
import { containsSensitiveContent } from "./privacy";

export const DEFAULT_REINDEX_BATCH_SIZE = 25;
export const MAX_REINDEX_BATCH_SIZE = MAX_EMBEDDING_BATCH_SIZE;

export type RecordErrorReason =
  | "empty_normalized_value"
  | "sensitive_content_skipped"
  | "http_400"
  | "http_413"
  | "http_422"
  | "non_finite_vector";

export type ServiceErrorReason =
  | "connection_error"
  | "timeout"
  | "configuration_error"
  | "dimension_mismatch"
  | "invalid_provider_response"
  | "storage_error"
  | "unexpected_error"
  | `http_${number}`;

export interface ReindexStore {
  listPendingEmbeddings(
    model: string,
    limit: number,
    afterId?: string,
  ): Promise<PendingEmbeddingRecord[]>;
  saveEmbeddingsBatch(
    model: string,
    items: ReadonlyArray<PreparedEmbeddingItem>,
  ): Promise<SaveEmbeddingsBatchResult>;
}

export interface ReindexProgressSnapshot {
  readonly modelIdentity: string;
  readonly digestPinnedInConfig: boolean;
  readonly batchesCompleted: number;
  readonly scanned: number;
  readonly written: number;
  readonly skippedDeleted: number;
  readonly skippedStale: number;
  readonly skippedEmpty: number;
  readonly failedRecords: number;
  readonly recordErrorCounts: Readonly<Partial<Record<RecordErrorReason, number>>>;
}

export type ReindexResult = ReindexProgressSnapshot;

export interface ResolveProviderIdentityOptions {
  providerName?: string;
  digest?: string;
  hashVersion?: string;
  extra?: Record<string, string>;
}

export interface ResolveConfiguredIdentityOptions extends ResolveProviderIdentityOptions {
  modelName?: string;
  dimensions?: number;
}

export interface ReindexOptions extends ResolveProviderIdentityOptions {
  batchSize?: number;
  /**
   * Cooperative cancellation signal.
   *
   * Boundary limitation: The current `EmbeddingProvider.embed()` interface in `src/embedding.ts`
   * does not accept an `AbortSignal`. Therefore, aborting `signal` does NOT immediately terminate
   * an already in-flight `provider.embed()` request. Instead, cancellation takes effect at
   * cooperative boundaries: before fetching each batch, before starting the next `provider.embed()`
   * call, immediately after the current in-flight `provider.embed()` call settles, and before
   * persisting an uncommitted batch.
   */
  signal?: AbortSignal;
  embedOptions?: EmbeddingOptions;
  onProgress?: (snapshot: ReindexProgressSnapshot) => void;
}

export class ReindexConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReindexConfigurationError";
  }
}

export class ReindexAbortedError extends Error {
  readonly summary: ReindexProgressSnapshot;

  constructor(summary: ReindexProgressSnapshot) {
    super("Reindexing was cancelled via AbortSignal.");
    this.name = "ReindexAbortedError";
    this.summary = summary;
  }
}

export class ReindexServiceError extends Error {
  readonly reason: ServiceErrorReason;
  readonly status?: number;
  readonly summary: ReindexProgressSnapshot;

  constructor(
    message: string,
    reason: ServiceErrorReason,
    summary: ReindexProgressSnapshot,
    status?: number,
  ) {
    super(message);
    this.name = "ReindexServiceError";
    this.reason = reason;
    this.status = status;
    this.summary = summary;
  }
}

/**
 * Resolves the target embedding model identity purely from configuration and defaults
 * (`JARVIS_EMBEDDING_MODEL`, `JARVIS_EMBEDDING_DIGEST`, `DEFAULT_EMBEDDING_MODEL`,
 * `DEFAULT_EMBEDDING_DIMENSIONS`) without instantiating an `EmbeddingProvider` or
 * making any network calls. Shared by both `stats` and `resolveProviderModelIdentity`.
 */
export function resolveConfiguredModelIdentity(
  options: ResolveConfiguredIdentityOptions = {},
): ResolvedEmbeddingModelIdentity {
  const providerName = options.providerName ?? "ollama";
  const modelName =
    options.modelName !== undefined
      ? options.modelName
      : (process.env.JARVIS_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL);
  const dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const digest =
    options.digest !== undefined
      ? options.digest
      : process.env.JARVIS_EMBEDDING_DIGEST;

  return buildEmbeddingModelIdentity({
    provider: providerName,
    modelName,
    dimensions,
    hashVersion: options.hashVersion ?? EMBEDDING_HASH_VERSION,
    digest,
    extra: options.extra,
  });
}

export function resolveProviderModelIdentity(
  provider: Pick<EmbeddingProvider, "modelName" | "dimensions">,
  options: ResolveProviderIdentityOptions = {},
): ResolvedEmbeddingModelIdentity {
  const providerName =
    options.providerName ??
    (provider instanceof OllamaEmbeddingProvider ? "ollama" : "custom");

  return resolveConfiguredModelIdentity({
    ...options,
    providerName,
    modelName: provider.modelName,
    dimensions: provider.dimensions,
  });
}

/**
 * Reindexes pending or stale memories in bounded batches outside SQLite write locks.
 *
 * Cancellation note: Because `EmbeddingProvider.embed()` does not accept an `AbortSignal`,
 * `options.signal` is evaluated cooperatively between embedding calls (and immediately after
 * an in-flight `provider.embed()` call completes) rather than aborting an active HTTP request
 * mid-flight.
 */
export async function reindexMemories(
  store: ReindexStore,
  provider: EmbeddingProvider,
  options: ReindexOptions = {},
): Promise<ReindexResult> {
  const batchSize = options.batchSize ?? DEFAULT_REINDEX_BATCH_SIZE;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_REINDEX_BATCH_SIZE
  ) {
    throw new ReindexConfigurationError(
      `batchSize must be an integer between 1 and ${MAX_REINDEX_BATCH_SIZE}.`,
    );
  }

  let resolvedIdentity: ResolvedEmbeddingModelIdentity;
  try {
    resolvedIdentity = resolveProviderModelIdentity(provider, options);
  } catch (error) {
    throw new ReindexConfigurationError(
      error instanceof Error ? error.message : "Invalid embedding model identity configuration.",
    );
  }

  let batchesCompleted = 0;
  let scanned = 0;
  let written = 0;
  let skippedDeleted = 0;
  let skippedStale = 0;
  let skippedEmpty = 0;
  let failedRecords = 0;
  const recordErrorCounts: Partial<Record<RecordErrorReason, number>> = {};

  const recordFailure = (reason: RecordErrorReason): void => {
    failedRecords += 1;
    recordErrorCounts[reason] = (recordErrorCounts[reason] ?? 0) + 1;
  };

  const buildSnapshot = (): ReindexProgressSnapshot => ({
    modelIdentity: resolvedIdentity.identity,
    digestPinnedInConfig: resolvedIdentity.digestPinnedInConfig,
    batchesCompleted,
    scanned,
    written,
    skippedDeleted,
    skippedStale,
    skippedEmpty,
    failedRecords,
    recordErrorCounts: { ...recordErrorCounts },
  });

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw new ReindexAbortedError(buildSnapshot());
    }
  };

  let afterId: string | undefined;

  while (true) {
    throwIfAborted();

    let batch: PendingEmbeddingRecord[];
    try {
      batch = await store.listPendingEmbeddings(
        resolvedIdentity.identity,
        batchSize,
        afterId,
      );
    } catch {
      throw new ReindexServiceError(
        "Failed to read pending records from the memory store.",
        "storage_error",
        buildSnapshot(),
      );
    }

    if (batch.length === 0) {
      break;
    }

    afterId = batch[batch.length - 1]!.id;
    const preparedItems: PreparedEmbeddingItem[] = [];

    // Phase 2: Compute embeddings strictly outside SQLite transactions and write locks.
    for (const record of batch) {
      throwIfAborted();

      if (containsSensitiveContent(record.value)) {
        recordFailure("sensitive_content_skipped");
        continue;
      }

      const normalizedText = normalizeEmbeddingInput(record.value);
      if (!normalizedText) {
        skippedEmpty += 1;
        recordFailure("empty_normalized_value");
        continue;
      }

      const contentHash = computeEmbeddingInputHash(record.value);
      let vector: Float32Array;
      try {
        vector = await provider.embed(normalizedText, options.embedOptions);
      } catch (error) {
        if (options.signal?.aborted) {
          throw new ReindexAbortedError(buildSnapshot());
        }
        const recordScopedReason = classifyRecordScopedError(error);
        if (recordScopedReason !== null) {
          recordFailure(recordScopedReason);
          continue;
        }
        throw toServiceError(error, buildSnapshot());
      }

      // Check cooperative cancellation immediately after the in-flight embed() call finishes.
      throwIfAborted();

      if (!(vector instanceof Float32Array) || vector.length !== resolvedIdentity.dimensions) {
        throw new ReindexServiceError(
          `Embedding provider returned invalid vector dimensions (expected ${resolvedIdentity.dimensions}).`,
          "dimension_mismatch",
          buildSnapshot(),
        );
      }

      let hasNonFinite = false;
      for (let i = 0; i < vector.length; i++) {
        if (!Number.isFinite(vector[i])) {
          hasNonFinite = true;
          break;
        }
      }
      if (hasNonFinite) {
        recordFailure("non_finite_vector");
        continue;
      }

      preparedItems.push({
        memoryId: record.id,
        dimensions: resolvedIdentity.dimensions,
        contentHash,
        vector,
      });
    }

    throwIfAborted();

    // Phase 3: Persist batch in a short atomic transaction with optimistic value_hash verification.
    if (preparedItems.length > 0) {
      let saveResult: SaveEmbeddingsBatchResult;
      try {
        saveResult = await store.saveEmbeddingsBatch(
          resolvedIdentity.identity,
          preparedItems,
        );
      } catch {
        throw new ReindexServiceError(
          "Failed to persist embedding batch to the memory store.",
          "storage_error",
          buildSnapshot(),
        );
      }
      written += saveResult.written;
      skippedDeleted += saveResult.skippedDeleted;
      skippedStale += saveResult.skippedStale;
    }

    scanned += batch.length;
    batchesCompleted += 1;
    options.onProgress?.(buildSnapshot());
  }

  return buildSnapshot();
}

function classifyRecordScopedError(error: unknown): RecordErrorReason | null {
  if (error instanceof EmbeddingAPIError) {
    if (error.status === 400) return "http_400";
    if (error.status === 413) return "http_413";
    if (error.status === 422) return "http_422";
    return null;
  }
  if (
    error instanceof EmbeddingResponseError &&
    /invalid numeric value/i.test(error.message)
  ) {
    return "non_finite_vector";
  }
  return null;
}

function toServiceError(
  error: unknown,
  summary: ReindexProgressSnapshot,
): ReindexServiceError {
  if (error instanceof EmbeddingConnectionError) {
    return new ReindexServiceError(
      "Embedding service connection failed.",
      "connection_error",
      summary,
    );
  }
  if (error instanceof EmbeddingTimeoutError) {
    return new ReindexServiceError(
      "Embedding service request timed out.",
      "timeout",
      summary,
    );
  }
  if (error instanceof EmbeddingAPIError) {
    const status = error.status;
    const reason: ServiceErrorReason =
      typeof status === "number" ? `http_${status}` : "unexpected_error";
    return new ReindexServiceError(
      typeof status === "number"
        ? `Embedding service returned HTTP ${status}.`
        : "Embedding service returned an API error.",
      reason,
      summary,
      status,
    );
  }
  if (error instanceof EmbeddingConfigurationError) {
    return new ReindexServiceError(
      "Embedding provider configuration error.",
      "configuration_error",
      summary,
    );
  }
  if (error instanceof EmbeddingResponseError) {
    if (/Expected embedding vector of dimension/i.test(error.message)) {
      return new ReindexServiceError(
        "Embedding provider returned unexpected vector dimensions.",
        "dimension_mismatch",
        summary,
      );
    }
    return new ReindexServiceError(
      "Embedding service returned an invalid response payload.",
      "invalid_provider_response",
      summary,
    );
  }
  return new ReindexServiceError(
    "Unexpected error during embedding generation.",
    "unexpected_error",
    summary,
  );
}
