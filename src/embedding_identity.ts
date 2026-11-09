export interface EmbeddingModelIdentityInput {
  provider: string;
  modelName: string;
  dimensions: number;
  hashVersion: string;
  digest?: string;
  extra?: Record<string, string>;
}

/**
 * Resolved canonical identity for an embedding configuration.
 *
 * IMPORTANT — `digestPinnedInConfig` semantics & Vector Space Drift warning:
 * - `digestPinnedInConfig: true` means ONLY that a non-empty `digest` string was explicitly
 *   provided in local configuration (e.g., via `JARVIS_EMBEDDING_DIGEST`). It does NOT verify
 *   over the network or at runtime that the Ollama server has actually loaded weights matching
 *   that digest.
 * - Risk of stale digest (Vector Space Drift): If model weights are updated in Ollama
 *   (for example via `ollama pull`) while an older `digest` value remains configured locally,
 *   the generated `identity` string will stay unchanged. Stored embeddings from the previous
 *   weights will continue to be treated as valid alongside newly computed query vectors from
 *   the updated weights, causing silent vector space drift. Whenever model weights change,
 *   update the configured digest (if used) and run `reindex`.
 */
export interface ResolvedEmbeddingModelIdentity {
  identity: string;
  provider: string;
  modelName: string;
  dimensions: number;
  hashVersion: string;
  digest: string | null;
  digestPinnedInConfig: boolean;
}

const RESERVED_EXTRA_DELIMITER_PATTERN = /[|=]/;
const RESERVED_SEGMENT_PIPE_PATTERN = /\|/;

/**
 * Builds a deterministic, canonical embedding model identity string shared across
 * `reindex`, `stats`, and semantic `search`.
 *
 * Format:
 *   `<provider>:<modelName>[#<digest>]|dim=<dimensions>|norm=<hashVersion>[|<key>=<value>...]`
 *
 * Note: Never appends `:latest` implicitly and never treats `latest` as an immutable digest.
 */
export function buildEmbeddingModelIdentity(
  input: EmbeddingModelIdentityInput,
): ResolvedEmbeddingModelIdentity {
  const provider = input.provider.trim();
  const modelName = input.modelName.trim();
  const hashVersion = input.hashVersion.trim();
  const rawDigest = input.digest?.trim() ?? "";
  const digest = rawDigest.length > 0 ? rawDigest : null;

  if (!provider) {
    throw new Error("Embedding provider must not be empty.");
  }
  if (RESERVED_SEGMENT_PIPE_PATTERN.test(provider) || /[:#=]/.test(provider)) {
    throw new Error("Embedding provider contains reserved identity delimiters.");
  }

  if (!modelName) {
    throw new Error("Embedding model name must not be empty.");
  }
  if (RESERVED_SEGMENT_PIPE_PATTERN.test(modelName) || modelName.includes("#")) {
    throw new Error("Embedding model name contains reserved identity delimiters.");
  }

  if (!Number.isInteger(input.dimensions) || input.dimensions < 1) {
    throw new Error("Embedding dimensions must be a positive integer.");
  }

  if (!hashVersion) {
    throw new Error("Embedding hash version must not be empty.");
  }
  if (RESERVED_SEGMENT_PIPE_PATTERN.test(hashVersion) || hashVersion.includes("=")) {
    throw new Error("Embedding hash version contains reserved identity delimiters.");
  }

  if (digest !== null && (RESERVED_SEGMENT_PIPE_PATTERN.test(digest) || digest.includes("#"))) {
    throw new Error("Embedding digest contains reserved identity delimiters.");
  }

  const normalizedExtraEntries: Array<[string, string]> = [];
  const seenKeys = new Set<string>();

  for (const [rawKey, rawValue] of Object.entries(input.extra ?? {})) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) {
      throw new Error("Embedding identity extra keys and values must not be empty.");
    }
    if (
      RESERVED_EXTRA_DELIMITER_PATTERN.test(key) ||
      RESERVED_EXTRA_DELIMITER_PATTERN.test(value)
    ) {
      throw new Error(
        "Embedding identity extra keys and values must not contain reserved delimiters ('|' or '=').",
      );
    }
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate embedding identity extra key after trimming: "${key}".`);
    }
    seenKeys.add(key);
    normalizedExtraEntries.push([key, value]);
  }

  normalizedExtraEntries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  const base = `${provider}:${modelName}${digest ? `#${digest}` : ""}|dim=${input.dimensions}|norm=${hashVersion}`;

  const identity = [
    base,
    ...normalizedExtraEntries.map(([key, value]) => `${key}=${value}`),
  ].join("|");

  return {
    identity,
    provider,
    modelName,
    dimensions: input.dimensions,
    hashVersion,
    digest,
    digestPinnedInConfig: digest !== null,
  };
}
