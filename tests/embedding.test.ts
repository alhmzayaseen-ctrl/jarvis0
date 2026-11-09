import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_KEEP_ALIVE,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  DEFAULT_OLLAMA_HOST,
  EmbeddingAPIError,
  EmbeddingConfigurationError,
  EmbeddingConnectionError,
  EmbeddingResponseError,
  EmbeddingTimeoutError,
  OllamaEmbeddingProvider,
} from "../src/embedding";

const prevHost = process.env.OLLAMA_HOST;
const prevModel = process.env.JARVIS_EMBEDDING_MODEL;
const prevTimeout = process.env.JARVIS_EMBEDDING_TIMEOUT_MS;
const prevKeepAlive = process.env.JARVIS_KEEP_ALIVE;

afterEach(() => {
  restoreEnvironment("OLLAMA_HOST", prevHost);
  restoreEnvironment("JARVIS_EMBEDDING_MODEL", prevModel);
  restoreEnvironment("JARVIS_EMBEDDING_TIMEOUT_MS", prevTimeout);
  restoreEnvironment("JARVIS_KEEP_ALIVE", prevKeepAlive);
});

function createDummyVector(dim: number, val = 0.1): number[] {
  return Array.from({ length: dim }, (_, i) => val + i * 0.001);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withMockFetch<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── 1. Valid Request & Response ──────────────────────────────────────────────

test("embed() sends valid POST to /api/embed and returns Float32Array with 1024 dimensions", async () =>
  withMockFetch(async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const dummy1024 = createDummyVector(1024);

    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse({
        model: "bge-m3",
        embeddings: [dummy1024],
      });
    };

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed("Autonomous AI agent memory");

    assert.ok(result instanceof Float32Array);
    assert.equal(result.length, 1024);
    assert.equal(capturedUrl, "http://localhost:11434/api/embed");
    assert.equal(capturedInit?.method, "POST");

    const reqBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(reqBody.model, "bge-m3");
    assert.equal(reqBody.input, "Autonomous AI agent memory");
    assert.equal(reqBody.keep_alive, "5m");
  }));

test("embed() supports legacy /api/embeddings format containing single embedding array", async () =>
  withMockFetch(async () => {
    const dummy1024 = createDummyVector(1024, 0.5);
    globalThis.fetch = async () =>
      jsonResponse({
        embedding: dummy1024,
      });

    const provider = new OllamaEmbeddingProvider();
    const result = await provider.embed("Test query");

    assert.ok(result instanceof Float32Array);
    assert.equal(result.length, 1024);
    assert.equal(result[0], dummy1024[0]);
  }));

// ── 2. Response Structure Validation ─────────────────────────────────────────

test("embed() throws EmbeddingResponseError when response body is not an object or lacks embeddings", async () =>
  withMockFetch(async () => {
    const provider = new OllamaEmbeddingProvider();

    // Not JSON / invalid JSON
    globalThis.fetch = async () => new Response("plain text error", { status: 200 });
    await assert.rejects(provider.embed("Test"), EmbeddingResponseError);

    // Empty object
    globalThis.fetch = async () => jsonResponse({});
    await assert.rejects(provider.embed("Test"), EmbeddingResponseError);

    // Empty embeddings array
    globalThis.fetch = async () => jsonResponse({ embeddings: [] });
    await assert.rejects(provider.embed("Test"), EmbeddingResponseError);

    // Embeddings is not array of arrays
    globalThis.fetch = async () => jsonResponse({ embeddings: ["string-not-vector"] });
    await assert.rejects(provider.embed("Test"), EmbeddingResponseError);
  }));

// ── 3. Dimension Validation ──────────────────────────────────────────────────

test("embed() throws EmbeddingResponseError if returned vector length does not match expected dimensions", async () =>
  withMockFetch(async () => {
    const provider = new OllamaEmbeddingProvider({ dimensions: 1024 });

    // Returns 768 dimensions instead of 1024
    globalThis.fetch = async () =>
      jsonResponse({
        embeddings: [createDummyVector(768)],
      });

    await assert.rejects(
      provider.embed("Test"),
      (err: unknown) =>
        err instanceof EmbeddingResponseError &&
        err.message.includes("Expected embedding vector of dimension 1024, got 768."),
    );
  }));

// ── 4. Value Sanitization (NaN, Infinity, non-numeric) ────────────────────────

test("embed() rejects NaN, Infinity, -Infinity, and non-numeric values in vector", async () =>
  withMockFetch(async () => {
    const provider = new OllamaEmbeddingProvider({ dimensions: 1024 });

    for (const badValue of [NaN, Infinity, -Infinity, "0.5", null, undefined]) {
      const vector = createDummyVector(1024);
      vector[5] = badValue as any;

      globalThis.fetch = async () =>
        jsonResponse({
          embeddings: [vector],
        });

      await assert.rejects(
        provider.embed("Test"),
        (err: unknown) =>
          err instanceof EmbeddingResponseError &&
          err.message.includes("Embedding vector contains invalid numeric value"),
      );
    }
  }));

// ── 5. Error Handling: HTTP Error, Timeout, Network Failure ──────────────────

test("embed() throws EmbeddingAPIError on non-200 HTTP responses without retries", async () =>
  withMockFetch(async () => {
    const provider = new OllamaEmbeddingProvider();

    for (const status of [400, 404, 500, 503]) {
      globalThis.fetch = async () => new Response("Not found or failed", { status });
      await assert.rejects(
        provider.embed("Test"),
        (err: unknown) => err instanceof EmbeddingAPIError && err.status === status,
      );
    }
  }));

test("embed() throws EmbeddingTimeoutError on request timeout", async () =>
  withMockFetch(async () => {
    globalThis.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

    const provider = new OllamaEmbeddingProvider({ timeoutMs: 5 });
    await assert.rejects(provider.embed("Test"), EmbeddingTimeoutError);
  }));

test("embed() throws EmbeddingConnectionError when fetch throws network error", async () =>
  withMockFetch(async () => {
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    };

    const provider = new OllamaEmbeddingProvider();
    await assert.rejects(provider.embed("Test"), EmbeddingConnectionError);
  }));

test("embed() rejects empty or whitespace-only text with EmbeddingConfigurationError", async () => {
  const provider = new OllamaEmbeddingProvider();
  await assert.rejects(provider.embed(""), EmbeddingConfigurationError);
  await assert.rejects(provider.embed("   "), EmbeddingConfigurationError);
});

// ── 6. healthCheck() Behavior ────────────────────────────────────────────────

test("healthCheck() returns true when Ollama responds with valid embedding", async () =>
  withMockFetch(async () => {
    globalThis.fetch = async () =>
      jsonResponse({
        embeddings: [createDummyVector(1024)],
      });

    const provider = new OllamaEmbeddingProvider();
    const isHealthy = await provider.healthCheck();
    assert.equal(isHealthy, true);
  }));

test("healthCheck() returns false when Ollama is offline or returns error without throwing", async () =>
  withMockFetch(async () => {
    const provider = new OllamaEmbeddingProvider();

    // Network error
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    assert.equal(await provider.healthCheck(), false);

    // 500 Error
    globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });
    assert.equal(await provider.healthCheck(), false);

    // Wrong dimensions
    globalThis.fetch = async () => jsonResponse({ embeddings: [createDummyVector(512)] });
    assert.equal(await provider.healthCheck(), false);
  }));

// ── 7. Options & Environment Variables ───────────────────────────────────────

test("supports custom options and override parameters in embed()", async () =>
  withMockFetch(async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ embeddings: [createDummyVector(1024)] });
    };

    const provider = new OllamaEmbeddingProvider({
      host: "http://192.168.1.10:11434/",
      model: "custom-embed-model",
      dimensions: 1024,
      keepAlive: "10m",
      timeoutMs: 15_000,
    });

    assert.equal(provider.host, "http://192.168.1.10:11434");
    assert.equal(provider.modelName, "custom-embed-model");
    assert.equal(provider.dimensions, 1024);
    assert.equal(provider.defaultKeepAlive, "10m");
    assert.equal(provider.defaultTimeoutMs, 15_000);

    // Override keepAlive in call
    await provider.embed("Hello", { keepAlive: "1m" });
    assert.equal(capturedBody?.keep_alive, "1m");
    assert.equal(capturedBody?.model, "custom-embed-model");
  }));

test("fromEnv() respects environment variables", () => {
  process.env.OLLAMA_HOST = "http://my-ollama:11434";
  process.env.JARVIS_EMBEDDING_MODEL = "nomic-embed-text-v2-moe";
  process.env.JARVIS_EMBEDDING_TIMEOUT_MS = "8000";
  process.env.JARVIS_KEEP_ALIVE = "2m";

  const provider = OllamaEmbeddingProvider.fromEnv({ dimensions: 768 });
  assert.equal(provider.host, "http://my-ollama:11434");
  assert.equal(provider.modelName, "nomic-embed-text-v2-moe");
  assert.equal(provider.dimensions, 768);
  assert.equal(provider.defaultTimeoutMs, 8000);
  assert.equal(provider.defaultKeepAlive, "2m");
});

test("fromEnv() falls back to defaults when environment variables are unset", () => {
  delete process.env.OLLAMA_HOST;
  delete process.env.JARVIS_EMBEDDING_MODEL;
  delete process.env.JARVIS_EMBEDDING_TIMEOUT_MS;
  delete process.env.JARVIS_KEEP_ALIVE;

  const provider = OllamaEmbeddingProvider.fromEnv();
  assert.equal(provider.host, DEFAULT_OLLAMA_HOST);
  assert.equal(provider.modelName, DEFAULT_EMBEDDING_MODEL);
  assert.equal(provider.dimensions, DEFAULT_EMBEDDING_DIMENSIONS);
  assert.equal(provider.defaultTimeoutMs, DEFAULT_EMBEDDING_TIMEOUT_MS);
  assert.equal(provider.defaultKeepAlive, DEFAULT_EMBEDDING_KEEP_ALIVE);
});

test("constructor rejects invalid dimensions, timeout, or empty model", () => {
  assert.throws(
    () => new OllamaEmbeddingProvider({ model: "   " }),
    EmbeddingConfigurationError,
  );
  assert.throws(
    () => new OllamaEmbeddingProvider({ dimensions: 0 }),
    EmbeddingConfigurationError,
  );
  assert.throws(
    () => new OllamaEmbeddingProvider({ dimensions: -5 }),
    EmbeddingConfigurationError,
  );
  assert.throws(
    () => new OllamaEmbeddingProvider({ timeoutMs: 0 }),
    EmbeddingConfigurationError,
  );
  assert.throws(
    () => new OllamaEmbeddingProvider({ timeoutMs: -100 }),
    EmbeddingConfigurationError,
  );
});
