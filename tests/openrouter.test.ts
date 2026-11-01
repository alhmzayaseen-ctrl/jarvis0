import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  OPENROUTER_FREE_ROUTER,
  OpenRouterAPIError,
  OpenRouterConfigurationError,
  OpenRouterConnectionError,
  OpenRouterProvider,
  OpenRouterResponseError,
  OpenRouterSensitiveRequestError,
  OpenRouterTimeoutError,
} from "../src/openrouter";

const previousApiKey = process.env.OPENROUTER_API_KEY;
const previousModel = process.env.OPENROUTER_MODEL;

afterEach(() => {
  restoreEnvironment("OPENROUTER_API_KEY", previousApiKey);
  restoreEnvironment("OPENROUTER_MODEL", previousModel);
});

test("uses the free router by default and sends the key only as a bearer header", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  delete process.env.OPENROUTER_MODEL;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return jsonResponse({ choices: [{ message: { content: "Hello from Jarvis" } }] });
  };
  const provider = OpenRouterProvider.fromEnv();

  assert.equal(await provider.complete({ prompt: "Say hello", context: "Be concise." }), "Hello from Jarvis");
  assert.equal(capturedUrl, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(capturedInit?.redirect, "error");
  assert.equal(new Headers(capturedInit?.headers).get("authorization"), "Bearer local-test-key");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: OPENROUTER_FREE_ROUTER,
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Say hello" },
    ],
    max_tokens: 256,
  });
  assert.equal(String(capturedInit?.body).includes("local-test-key"), false);
}));

test("always sends requests through the OpenRouter free router", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  process.env.OPENROUTER_MODEL = OPENROUTER_FREE_ROUTER;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ choices: [{ message: { content: "Free model" } }] });
  };
  const provider = OpenRouterProvider.fromEnv();

  assert.equal(await provider.complete({ prompt: "Test" }), "Free model");
  assert.equal(requestBody?.model, OPENROUTER_FREE_ROUTER);
}));

test("blocks sensitive requests when OpenRouter is called directly", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ choices: [{ message: { content: "unexpected" } }] });
  };
  const provider = OpenRouterProvider.fromEnv();

  await assert.rejects(
    provider.complete({ prompt: "My password is never-send-this." }),
    OpenRouterSensitiveRequestError,
  );
  await assert.rejects(
    provider.complete({ prompt: "ordinary", privacyLevel: "sensitive" }),
    OpenRouterSensitiveRequestError,
  );
  assert.equal(fetchCalls, 0);
}));

test("rejects missing credentials and paid or malformed model IDs", () => {
  delete process.env.OPENROUTER_API_KEY;
  assert.throws(() => OpenRouterProvider.fromEnv(), OpenRouterConfigurationError);

  process.env.OPENROUTER_API_KEY = "local-test-key";
  process.env.OPENROUTER_MODEL = "example/paid-model";
  assert.throws(() => OpenRouterProvider.fromEnv(), OpenRouterConfigurationError);
  process.env.OPENROUTER_MODEL = "example/model:free";
  assert.throws(() => OpenRouterProvider.fromEnv(), OpenRouterConfigurationError);
  process.env.OPENROUTER_MODEL = OPENROUTER_FREE_ROUTER;
  assert.throws(() => OpenRouterProvider.fromEnv({ timeoutMs: 0 }), OpenRouterConfigurationError);
});

test("reports HTTP 401, 402, 429, and 500 without retries or leaking response bodies", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  for (const status of [401, 402, 429, 500]) {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response("sensitive provider response", { status });
    };
    const provider = OpenRouterProvider.fromEnv();

    await assert.rejects(
      provider.complete({ prompt: "Test" }),
      (error: unknown) =>
        error instanceof OpenRouterAPIError &&
        error.status === status &&
        !error.message.includes("sensitive") &&
        !error.message.includes("local-test-key"),
    );
    assert.equal(attempts, 1, `HTTP ${status} must not trigger a retry`);
  }
}));

test("distinguishes connection failures, timeouts, and malformed responses", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  globalThis.fetch = async () => {
    throw new Error("network failure containing local-test-key");
  };
  const connectionFailure = OpenRouterProvider.fromEnv();
  await assert.rejects(connectionFailure.complete({ prompt: "Test" }), (error: unknown) =>
    error instanceof OpenRouterConnectionError &&
    !error.message.includes("local-test-key") &&
    error.cause === undefined,
  );

  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const timedOut = OpenRouterProvider.fromEnv({ timeoutMs: 5 });
  await assert.rejects(timedOut.complete({ prompt: "Test" }), OpenRouterTimeoutError);

  globalThis.fetch = async () => new Response("not-json", { status: 200 });
  const invalidJson = OpenRouterProvider.fromEnv();
  await assert.rejects(invalidJson.complete({ prompt: "Test" }), OpenRouterResponseError);
}));

test("rejects empty prompts and unexpected response shapes", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  globalThis.fetch = async () => jsonResponse({ choices: [{ message: { content: null } }] });
  const unexpectedResponse = OpenRouterProvider.fromEnv();

  await assert.rejects(unexpectedResponse.complete({ prompt: "  " }), OpenRouterConfigurationError);
  await assert.rejects(unexpectedResponse.complete({ prompt: "Test" }), OpenRouterResponseError);
}));

test("trusts only original providers created through fromEnv", () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  const trusted = OpenRouterProvider.fromEnv();
  const proxy = new Proxy(trusted, {});
  const fabricated = Object.create(OpenRouterProvider.prototype) as OpenRouterProvider;
  const unregistered = Reflect.construct(OpenRouterProvider, [
    "local-test-key",
    OPENROUTER_FREE_ROUTER,
    30_000,
  ]) as OpenRouterProvider;

  assert.equal(OpenRouterProvider.isTrustedProvider(trusted), true);
  assert.equal(OpenRouterProvider.isTrustedProvider(proxy), false);
  assert.equal(OpenRouterProvider.isTrustedProvider(fabricated), false);
  assert.equal(OpenRouterProvider.isTrustedProvider(unregistered), false);
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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
