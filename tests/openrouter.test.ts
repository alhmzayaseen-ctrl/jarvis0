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
  OpenRouterTokenLimitError,
} from "../src/openrouter";

const previousApiKey = process.env.OPENROUTER_API_KEY;
const previousModel = process.env.OPENROUTER_MODEL;
const previousMaxTokens = process.env.JARVIS_MAX_TOKENS;

afterEach(() => {
  restoreEnvironment("OPENROUTER_API_KEY", previousApiKey);
  restoreEnvironment("OPENROUTER_MODEL", previousModel);
  restoreEnvironment("JARVIS_MAX_TOKENS", previousMaxTokens);
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
    max_tokens: 2048,
  });
  assert.equal(String(capturedInit?.body).includes("local-test-key"), false);

  // ADD-05: Ensure apiKey does not leak through JSON serialization, util.inspect, or enumerable properties
  const inspected = (await import("node:util")).inspect(provider);
  assert.equal(inspected.includes("local-test-key"), false);
  const serialized = JSON.stringify(provider);
  assert.equal(serialized.includes("local-test-key"), false);
  assert.deepEqual(Object.keys(provider), []);
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
  for (const level of ["sensitive", "SENSITIVE", "sensitive ", " sensitive", " Sensitive "]) {
    await assert.rejects(
      provider.complete({ prompt: "ordinary", privacyLevel: level as any }),
      OpenRouterSensitiveRequestError,
    );
  }
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
    2048,
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

// ── Regression: token-budget and reasoning-only response shapes ───────────────

test("returns completion when finish_reason is stop and content is a string", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  globalThis.fetch = async () => jsonResponse({
    model: "some-model:free",
    choices: [{
      finish_reason: "stop",
      native_finish_reason: "stop",
      message: { role: "assistant", content: "Hello, I am Jarvis." },
    }],
  });
  const provider = OpenRouterProvider.fromEnv();
  const result = await provider.complete({ prompt: "Who are you?" });
  assert.equal(result, "Hello, I am Jarvis.");
}));

test("throws OpenRouterTokenLimitError when finish_reason is length and content is null", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  globalThis.fetch = async () => jsonResponse({
    model: "reasoning-model:free",
    choices: [{
      finish_reason: "length",
      native_finish_reason: "length",
      message: {
        role: "assistant",
        content: null,
        reasoning: "This is the internal reasoning that consumed the entire token budget...",
      },
    }],
  });
  const provider = OpenRouterProvider.fromEnv();
  await assert.rejects(
    provider.complete({ prompt: "Explain something complex." }),
    (error: unknown) => {
      assert.ok(error instanceof OpenRouterTokenLimitError,
        `Expected OpenRouterTokenLimitError, got ${(error as Error).constructor?.name}`);
      assert.ok(error instanceof OpenRouterResponseError,
        "OpenRouterTokenLimitError must be a subclass of OpenRouterResponseError");
      assert.ok(!error.message.includes("reasoning"),
        "Error message must not expose internal reasoning content");
      assert.ok(!error.message.includes("local-test-key"),
        "Error message must not contain the API key");
      return true;
    },
  );
}));

test("throws OpenRouterResponseError (not TokenLimitError) when content is null and finish_reason is not length", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  for (const finishReason of ["stop", "content_filter", null, undefined]) {
    globalThis.fetch = async () => jsonResponse({
      model: "some-model:free",
      choices: [{
        finish_reason: finishReason,
        message: { role: "assistant", content: null },
      }],
    });
    const provider = OpenRouterProvider.fromEnv();
    await assert.rejects(
      provider.complete({ prompt: "Test." }),
      (error: unknown) => {
        assert.ok(error instanceof OpenRouterResponseError,
          `Expected OpenRouterResponseError for finish_reason=${JSON.stringify(finishReason)}`);
        assert.ok(!(error instanceof OpenRouterTokenLimitError),
          `Must NOT be OpenRouterTokenLimitError for finish_reason=${JSON.stringify(finishReason)}`);
        return true;
      },
    );
  }
}));

test("throws OpenRouterResponseError when content is null with no finish_reason field", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  globalThis.fetch = async () => jsonResponse({
    choices: [{ message: { role: "assistant", content: null } }],
  });
  const provider = OpenRouterProvider.fromEnv();
  await assert.rejects(
    provider.complete({ prompt: "Test." }),
    OpenRouterResponseError,
  );
}));

test("reasoning field in response is never returned to callers or included in errors", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  const secretReasoning = "SECRET_INTERNAL_CHAIN_OF_THOUGHT_DO_NOT_EXPOSE";

  // Case 1: success path — reasoning must not appear in returned text
  globalThis.fetch = async () => jsonResponse({
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "The answer is 42.",
        reasoning: secretReasoning,
      },
    }],
  });
  let provider = OpenRouterProvider.fromEnv();
  const successResult = await provider.complete({ prompt: "What is the answer?" });
  assert.equal(successResult, "The answer is 42.");
  assert.ok(!successResult.includes(secretReasoning),
    "Reasoning must not leak into the returned completion text");

  // Case 2: failure path — reasoning must not appear in thrown error
  globalThis.fetch = async () => jsonResponse({
    choices: [{
      finish_reason: "length",
      message: { role: "assistant", content: null, reasoning: secretReasoning },
    }],
  });
  provider = OpenRouterProvider.fromEnv();
  await assert.rejects(
    provider.complete({ prompt: "What is the answer?" }),
    (error: unknown) => {
      assert.ok(error instanceof OpenRouterTokenLimitError);
      assert.ok(!(error as Error).message.includes(secretReasoning),
        "Reasoning must not leak into the error message");
      return true;
    },
  );
}));

// Verify default max_tokens is 2048 when JARVIS_MAX_TOKENS is unset
test("default max_tokens is 2048 when env var not set", async () =>
  withMockFetch(async () => {
    delete process.env.JARVIS_MAX_TOKENS;
    process.env.OPENROUTER_API_KEY = "local-test-key";
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    };
    const provider = OpenRouterProvider.fromEnv();
    await provider.complete({ prompt: "test" });
    assert.equal(capturedBodies.length, 1);
    assert.equal(capturedBodies[0].max_tokens, 2048);
  })
);

// Verify env var overrides default
test("env var JARVIS_MAX_TOKENS overrides max_tokens", async () =>
  withMockFetch(async () => {
    process.env.JARVIS_MAX_TOKENS = "4096";
    process.env.OPENROUTER_API_KEY = "local-test-key";
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    };
    const provider = OpenRouterProvider.fromEnv();
    await provider.complete({ prompt: "test" });
    assert.equal(capturedBodies[0].max_tokens, 4096);
  })
);

// Invalid env var values fallback to default 2048
test("invalid env var falls back to default", async () =>
  withMockFetch(async () => {
    process.env.JARVIS_MAX_TOKENS = "not-a-number";
    process.env.OPENROUTER_API_KEY = "local-test-key";
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    };
    const provider = OpenRouterProvider.fromEnv();
    await provider.complete({ prompt: "test" });
    assert.equal(capturedBodies[0].max_tokens, 2048);
  })
);

// Negative value fallback
test("negative env var falls back to default", async () =>
  withMockFetch(async () => {
    process.env.JARVIS_MAX_TOKENS = "-5";
    process.env.OPENROUTER_API_KEY = "local-test-key";
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    };
    const provider = OpenRouterProvider.fromEnv();
    await provider.complete({ prompt: "test" });
    assert.equal(capturedBodies[0].max_tokens, 2048);
  })
);

// Zero value fallback
test("zero env var falls back to default", async () =>
  withMockFetch(async () => {
    process.env.JARVIS_MAX_TOKENS = "0";
    process.env.OPENROUTER_API_KEY = "local-test-key";
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    };
    const provider = OpenRouterProvider.fromEnv();
    await provider.complete({ prompt: "test" });
    assert.equal(capturedBodies[0].max_tokens, 2048);
  })
);
