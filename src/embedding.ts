export interface EmbeddingOptions {
  timeoutMs?: number;
  keepAlive?: string;
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;

  embed(
    text: string,
    opts?: {
      timeoutMs?: number;
      keepAlive?: string;
      signal?: AbortSignal;
    },
  ): Promise<Float32Array>;

  healthCheck(): Promise<boolean>;
}

export class EmbeddingError extends Error {
  readonly status?: number;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
  }
}

export class EmbeddingConfigurationError extends EmbeddingError {}
export class EmbeddingConnectionError extends EmbeddingError {}
export class EmbeddingTimeoutError extends EmbeddingError {}
export class EmbeddingAPIError extends EmbeddingError {}
export class EmbeddingResponseError extends EmbeddingError {}

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_EMBEDDING_MODEL = "bge-m3";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 10_000;
export const DEFAULT_EMBEDDING_KEEP_ALIVE = "5m";

export interface OllamaEmbeddingProviderOptions {
  host?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  keepAlive?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly #host: string;
  readonly #model: string;
  readonly #dimensions: number;
  readonly #timeoutMs: number;
  readonly #keepAlive: string;

  constructor(options: OllamaEmbeddingProviderOptions = {}) {
    let host = DEFAULT_OLLAMA_HOST;
    if (options.host !== undefined) {
      const trimmedHost = options.host.trim();
      if (!trimmedHost) {
        throw new EmbeddingConfigurationError("Ollama host must not be empty.");
      }
      host = trimmedHost;
    }
    this.#host = host.replace(/\/+$/, "");

    let model = DEFAULT_EMBEDDING_MODEL;
    if (options.model !== undefined) {
      const trimmedModel = options.model.trim();
      if (!trimmedModel) {
        throw new EmbeddingConfigurationError("Embedding model name must not be empty.");
      }
      model = trimmedModel;
    }
    this.#model = model;

    const dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw new EmbeddingConfigurationError("Embedding dimensions must be a positive integer.");
    }
    this.#dimensions = dimensions;

    const timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new EmbeddingConfigurationError("timeoutMs must be a positive integer.");
    }
    this.#timeoutMs = timeoutMs;

    this.#keepAlive = options.keepAlive?.trim() || DEFAULT_EMBEDDING_KEEP_ALIVE;
    Object.freeze(this);
  }

  get modelName(): string {
    return this.#model;
  }

  get dimensions(): number {
    return this.#dimensions;
  }

  get host(): string {
    return this.#host;
  }

  get defaultTimeoutMs(): number {
    return this.#timeoutMs;
  }

  get defaultKeepAlive(): string {
    return this.#keepAlive;
  }

  static fromEnv(options: OllamaEmbeddingProviderOptions = {}): OllamaEmbeddingProvider {
    const host = options.host ?? process.env.OLLAMA_HOST;
    const model = options.model ?? process.env.JARVIS_EMBEDDING_MODEL;
    const keepAlive = options.keepAlive ?? process.env.JARVIS_KEEP_ALIVE;

    let timeoutMs = options.timeoutMs;
    const rawTimeout = process.env.JARVIS_EMBEDDING_TIMEOUT_MS;
    if (timeoutMs === undefined && rawTimeout !== undefined) {
      const parsed = Number(rawTimeout);
      if (Number.isInteger(parsed) && parsed > 0) {
        timeoutMs = parsed;
      }
    }

    return new OllamaEmbeddingProvider({
      host,
      model,
      dimensions: options.dimensions,
      timeoutMs,
      keepAlive,
    });
  }

  async embed(
    text: string,
    opts: {
      timeoutMs?: number;
      keepAlive?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<Float32Array> {
    if (typeof text !== "string" || !text.trim()) {
      throw new EmbeddingConfigurationError("Text to embed must not be empty.");
    }

    if (opts.signal?.aborted) {
      throw new EmbeddingTimeoutError("The embedding request was aborted.");
    }

    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new EmbeddingConfigurationError("timeoutMs must be a positive integer.");
    }

    const keepAlive = opts.keepAlive?.trim() || this.#keepAlive;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let onExternalAbort: (() => void) | undefined;
    if (opts.signal) {
      onExternalAbort = () => controller.abort();
      opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const url = `${this.#host}/api/embed`;
      const response = await globalThis.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.#model,
          input: text,
          keep_alive: keepAlive,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new EmbeddingAPIError(`Ollama returned HTTP ${response.status}.`, {
          status: response.status,
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (opts.signal?.aborted) {
          throw new EmbeddingTimeoutError("The embedding request was aborted.");
        }
        if (controller.signal.aborted) {
          throw new EmbeddingTimeoutError("The Ollama embedding request timed out.");
        }
        throw new EmbeddingResponseError("Ollama returned invalid JSON.");
      }

      const rawVector = this.extractVector(payload);
      this.validateVector(rawVector);
      return new Float32Array(rawVector);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (opts.signal?.aborted) {
        throw new EmbeddingTimeoutError("The embedding request was aborted.");
      }
      if (controller.signal.aborted) {
        throw new EmbeddingTimeoutError("The Ollama embedding request timed out.");
      }
      throw new EmbeddingConnectionError("Could not connect to Ollama.");
    } finally {
      clearTimeout(timeout);
      if (opts.signal && onExternalAbort) {
        opts.signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const vector = await this.embed("healthcheck", { timeoutMs: Math.min(this.#timeoutMs, 3_000) });
      return vector.length === this.#dimensions;
    } catch {
      return false;
    }
  }

  private extractVector(payload: unknown): number[] {
    const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
    if (!record) {
      throw new EmbeddingResponseError("Ollama response body is not a JSON object.");
    }

    // 1. Standard /api/embed format: { embeddings: [[...]] }
    if (Array.isArray(record.embeddings) && record.embeddings.length > 0 && Array.isArray(record.embeddings[0])) {
      return record.embeddings[0] as number[];
    }

    // 2. Legacy /api/embeddings format: { embedding: [...] }
    if (Array.isArray(record.embedding)) {
      return record.embedding as number[];
    }

    throw new EmbeddingResponseError("Ollama response did not contain an embedding vector.");
  }

  private validateVector(vector: unknown[]): asserts vector is number[] {
    if (vector.length !== this.#dimensions) {
      throw new EmbeddingResponseError(
        `Expected embedding vector of dimension ${this.#dimensions}, got ${vector.length}.`,
      );
    }

    for (let i = 0; i < vector.length; i++) {
      const val = vector[i];
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new EmbeddingResponseError(
          `Embedding vector contains invalid numeric value at index ${i}.`,
        );
      }
    }
  }
}
