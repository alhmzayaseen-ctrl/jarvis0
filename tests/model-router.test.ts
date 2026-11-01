import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  HybridModelRouter,
  LocalProviderUnavailableError,
  type ModelRouteEvent,
} from "../src/model-router";
import type { AIProvider, AIRequest } from "../src/provider";
import { OPENROUTER_FREE_ROUTER, OpenRouterProvider } from "../src/openrouter";
import { enforcePrivacyBoundary, PrivacyGuardProvider } from "../src/privacy-provider";

const originalApiKey = process.env.OPENROUTER_API_KEY;
const originalModel = process.env.OPENROUTER_MODEL;

afterEach(() => {
  restoreEnvironment("OPENROUTER_API_KEY", originalApiKey);
  restoreEnvironment("OPENROUTER_MODEL", originalModel);
});

test("routes ordinary and complex requests only through OpenRouter free", async () => withMockFetch(async () => {
  const requests: Array<Record<string, unknown>> = [];
  process.env.OPENROUTER_API_KEY = "local-test-key";
  delete process.env.OPENROUTER_MODEL;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse("free response");
  };
  const cloud = OpenRouterProvider.fromEnv();
  const events: ModelRouteEvent[] = [];
  const router = new HybridModelRouter({ freeCloudProvider: cloud, onRoute: (event) => events.push(event) });

  assert.equal(await router.complete({ prompt: "hello", taskType: "question" }), "free response");
  assert.equal(
    await router.complete({
      prompt: "implement a migration safely",
      taskType: "coding",
      importance: "high",
    }),
    "free response",
  );
  assert.deepEqual(requests.map(({ model }) => model), [
    OPENROUTER_FREE_ROUTER,
    OPENROUTER_FREE_ROUTER,
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[1].provider, "openrouter/free");
  assert.equal(events[1].importance, "high");
  assert.match(events[1].reason, /only configured cloud route/);
}));

test("passes the router-computed privacy level to OpenRouter", async () => {
  const originalComplete = OpenRouterProvider.prototype.complete;
  const requests: AIRequest[] = [];
  OpenRouterProvider.prototype.complete = async (request: AIRequest) => {
    requests.push(request);
    return "provider response";
  };

  try {
    const router = new HybridModelRouter({ freeCloudProvider: makeFreeProvider() });

    assert.equal(await router.complete({ prompt: "ordinary request" }), "provider response");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].privacyLevel, "normal");
  } finally {
    OpenRouterProvider.prototype.complete = originalComplete;
  }
});

test("does not invoke OpenRouter for a request inferred to be sensitive", async () => {
  const originalComplete = OpenRouterProvider.prototype.complete;
  let providerCalls = 0;
  OpenRouterProvider.prototype.complete = async () => {
    providerCalls += 1;
    return "unexpected response";
  };

  try {
    const router = new HybridModelRouter({ freeCloudProvider: makeFreeProvider() });

    await assert.rejects(
      router.complete({ prompt: "My password is never-send-this." }),
      LocalProviderUnavailableError,
    );
    assert.equal(providerCalls, 0);
  } finally {
    OpenRouterProvider.prototype.complete = originalComplete;
  }
});

test("onRoute errors do not affect a successful provider result", async () => withMockFetch(async () => {
  globalThis.fetch = async () => jsonResponse("successful response");
  const router = new HybridModelRouter({
    freeCloudProvider: makeFreeProvider(),
    onRoute: () => {
      throw new Error("observer failure");
    },
  });

  assert.equal(await router.complete({ prompt: "ordinary request" }), "successful response");
}));

test("onRoute errors do not replace the original provider error", async () => withMockFetch(async () => {
  globalThis.fetch = async () => {
    throw new Error("fetch failure");
  };
  const router = new HybridModelRouter({
    freeCloudProvider: makeFreeProvider(),
    onRoute: () => {
      throw new Error("observer failure");
    },
  });

  await assert.rejects(
    router.complete({ prompt: "ordinary request" }),
    (error: unknown) =>
      error instanceof Error && error.name === "OpenRouterConnectionError" &&
      error.message === "Could not connect to OpenRouter.",
  );
}));

test("onRoute errors do not replace LocalProviderUnavailableError", async () => {
  const router = new HybridModelRouter({
    freeCloudProvider: makeFreeProvider(),
    onRoute: () => {
      throw new Error("observer failure");
    },
  });

  await assert.rejects(
    router.complete({ prompt: "My password is never-send-this." }),
    LocalProviderUnavailableError,
  );
});

test("onRoute promise rejections do not affect a successful provider result", async () => withMockFetch(async () => {
  globalThis.fetch = async () => jsonResponse("successful response");
  const router = new HybridModelRouter({
    freeCloudProvider: makeFreeProvider(),
    onRoute: async () => {
      throw new Error("async observer failure");
    },
  });

  assert.equal(await router.complete({ prompt: "ordinary request" }), "successful response");
}));

test("rejects custom providers instead of routing requests to them", async () => {
  const requests: AIRequest[] = [];
  const customProvider: AIProvider = {
    complete: async (request) => {
      requests.push(request);
      return "custom response";
    },
  };
  assert.throws(
    () => enforcePrivacyBoundary(customProvider),
    /Only a trusted OpenRouter provider or HybridModelRouter is allowed/,
  );
  assert.equal(requests.length, 0);
});

test("a cloud-backed provider cannot claim local status or receive sensitive requests", async () => withMockFetch(async () => {
  let cloudCalls = 0;
  let wrapperCalls = 0;
  globalThis.fetch = async () => {
    cloudCalls += 1;
    return jsonResponse("cloud");
  };
  const cloud = makeFreeProvider();
  const wrapper = {
    providerKind: "local",
    complete: async (request: AIRequest) => {
      wrapperCalls += 1;
      return cloud.complete(request);
    },
  };
  assert.throws(
    () => enforcePrivacyBoundary(wrapper),
    /Only a trusted OpenRouter provider or HybridModelRouter is allowed/,
  );
  assert.equal(wrapperCalls, 0);
  assert.equal(cloudCalls, 0);
}));

test("a router subclass cannot masquerade as the trusted routing boundary", async () => withMockFetch(async () => {
  let cloudCalls = 0;
  globalThis.fetch = async () => {
    cloudCalls += 1;
    return jsonResponse("cloud");
  };
  const cloud = makeFreeProvider();
  const escapedRequests: AIRequest[] = [];
  class UntrustedRouter extends HybridModelRouter {
    override async complete(request: AIRequest): Promise<string> {
      escapedRequests.push(request);
      return "untrusted";
    }
  }
  const untrusted = new UntrustedRouter({ freeCloudProvider: cloud });
  assert.throws(
    () => enforcePrivacyBoundary(untrusted),
    /Only a trusted OpenRouter provider or HybridModelRouter is allowed/,
  );
  assert.equal(escapedRequests.length, 0);
  assert.equal(cloudCalls, 0);
}));

test("a proxy around a protected router cannot intercept sensitive requests", async () => withMockFetch(async () => {
  let cloudCalls = 0;
  globalThis.fetch = async () => {
    cloudCalls += 1;
    return jsonResponse("cloud");
  };
  const cloud = makeFreeProvider();
  const router = new HybridModelRouter({ freeCloudProvider: cloud });
  let interceptedCalls = 0;
  let externalCalls = 0;
  const externalProvider: AIProvider = {
    complete: async () => {
      externalCalls += 1;
      return "external response";
    },
  };
  const proxy = new Proxy(router, {
    get(target, property, receiver) {
      if (property === "complete") {
        return (request: AIRequest) => {
          interceptedCalls += 1;
          return externalProvider.complete(request);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.equal(HybridModelRouter.isProtectedRouter(proxy), false);
  assert.throws(
    () => enforcePrivacyBoundary(proxy),
    /Only a trusted OpenRouter provider or HybridModelRouter is allowed/,
  );
  assert.equal(interceptedCalls, 0);
  assert.equal(externalCalls, 0);
  assert.equal(cloudCalls, 0);
}));

test("a proxy around a privacy guard is not treated as trusted", async () => withMockFetch(async () => {
  const router = new HybridModelRouter({ freeCloudProvider: makeFreeProvider() });
  const guard = new PrivacyGuardProvider(router);
  let interceptedCalls = 0;
  const proxy = new Proxy(guard, {
    get(target, property, receiver) {
      if (property === "complete") {
        return () => {
          interceptedCalls += 1;
          return Promise.resolve("intercepted");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.equal(PrivacyGuardProvider.isProtectedGuard(proxy), false);
  assert.throws(
    () => enforcePrivacyBoundary(proxy),
    /Only a trusted OpenRouter provider or HybridModelRouter is allowed/,
  );
  assert.equal(interceptedCalls, 0);
}));

test("the router accepts only the original OpenRouter provider identity", () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  delete process.env.OPENROUTER_MODEL;
  const provider = makeFreeProvider();
  const proxy = new Proxy(provider, {});
  const fabricated = Object.create(OpenRouterProvider.prototype) as OpenRouterProvider;
  const unregistered = Reflect.construct(OpenRouterProvider, [
    "local-test-key",
    OPENROUTER_FREE_ROUTER,
    30_000,
  ]) as OpenRouterProvider;

  assert.doesNotThrow(() => new HybridModelRouter({ freeCloudProvider: provider }));
  for (const candidate of [proxy, fabricated, unregistered]) {
    assert.equal(OpenRouterProvider.isTrustedProvider(candidate), false);
    assert.throws(
      () => new HybridModelRouter({ freeCloudProvider: candidate }),
      /must be an OpenRouterProvider configured for openrouter\/free/,
    );
  }
});

test("route records contain no prompt or memory content", async () => withMockFetch(async () => {
  const privateMarker = "PRIVATE-MEMORY-MARKER-77";
  const cloudRequests: string[] = [];
  globalThis.fetch = async (_input, init) => {
    cloudRequests.push(String(init?.body));
    return jsonResponse("answer");
  };
  const cloud = makeFreeProvider();
  const events: ModelRouteEvent[] = [];
  const router = new HybridModelRouter({
    freeCloudProvider: cloud,
    onRoute: (event) => events.push(event),
  });

  await router.complete({
    prompt: "question",
    context: `memory=${privateMarker}`,
  });
  const routeLog = JSON.stringify([...events, ...router.getRouteEvents()]);
  assert.equal(routeLog.includes(privateMarker), false);
  assert.equal(routeLog.includes("question"), false);
  assert.equal(cloudRequests.some((body) => body.includes(privateMarker)), true);
}));

test("refuses sensitive cloud routing when no local provider is configured", async () => withMockFetch(async () => {
  let cloudCalls = 0;
  globalThis.fetch = async () => {
    cloudCalls += 1;
    return jsonResponse("cloud");
  };
  const cloud = makeFreeProvider();
  const events: ModelRouteEvent[] = [];
  const router = new HybridModelRouter({
    freeCloudProvider: cloud,
    onRoute: (event) => events.push(event),
  });

  await assert.rejects(
    router.complete({ prompt: "sensitive", privacyLevel: "sensitive" }),
    LocalProviderUnavailableError,
  );
  await assert.rejects(
    router.complete({ prompt: "My password is never-send-this." }),
    LocalProviderUnavailableError,
  );
  await assert.rejects(
    router.complete({ prompt: "Mijn wachtwoord is voorbeeld-geheim" }),
    LocalProviderUnavailableError,
  );
  await assert.rejects(
    router.complete({ prompt: "أعاني من السكري" }),
    LocalProviderUnavailableError,
  );
  assert.equal(cloudCalls, 0);
  assert.equal(events.length, 4);
  assert.ok(events.every(({ provider, success, privacyLevel }) =>
    provider === "none" && !success && privacyLevel === "sensitive"));
}));

function makeFreeProvider(): OpenRouterProvider {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  delete process.env.OPENROUTER_MODEL;
  return OpenRouterProvider.fromEnv();
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
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
