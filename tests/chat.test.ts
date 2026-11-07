import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { afterEach, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChatService,
  DEFAULT_MEMORY_PATH,
  runChat,
} from "../src/chat";
import { ConversationService, type ConversationMemory } from "../src/conversation";
import {
  MemoryConflictError,
  MemoryExistsError,
  type MemoryInput,
  type MemoryRecord,
} from "../src/memory";
import type { AIProvider, AIRequest } from "../src/provider";
import {
  OPENROUTER_FREE_ROUTER,
  OpenRouterConfigurationError,
  OpenRouterError,
  OpenRouterProvider,
} from "../src/openrouter";

class MockProvider implements AIProvider {
  readonly requests: AIRequest[] = [];

  constructor(private readonly response = "Hello from Jarvis") {}

  async complete(request: AIRequest): Promise<string> {
    this.requests.push(request);
    return this.response;
  }
}

class MockMemory implements ConversationMemory {
  readonly records = new Map<string, MemoryRecord>();
  readonly revisions = new Map<string, MemoryRecord[]>();

  async create(input: MemoryInput): Promise<MemoryRecord> {
    if (this.records.has(input.key)) throw new MemoryExistsError(input.key);
    const now = new Date().toISOString();
    const record = {
      ...input,
      id: `test-${input.key}`,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(input.key, record);
    this.revisions.set(input.key, [record]);
    return record;
  }

  async get(key: string): Promise<MemoryRecord | null> {
    return this.records.get(key) ?? null;
  }

  async search(query: string, limit = 10): Promise<MemoryRecord[]> {
    const words = query.toLowerCase().split(/\W+/u).filter(Boolean);
    return [...this.records.values()]
      .filter((record) =>
        words.some((word) => `${record.key} ${record.value}`.toLowerCase().includes(word)),
      )
      .slice(0, limit);
  }

  async update(key: string, expectedVersion: number, input: MemoryInput): Promise<MemoryRecord> {
    const current = this.records.get(key);
    if (!current || current.version !== expectedVersion) {
      throw new MemoryConflictError(key, expectedVersion, current?.version ?? null);
    }
    const updated = {
      ...input,
      id: current.id,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, updated);
    this.revisions.get(key)?.push(updated);
    return updated;
  }
}

const originalApiKey = process.env.OPENROUTER_API_KEY;
const originalModel = process.env.OPENROUTER_MODEL;

afterEach(() => {
  restoreEnvironment("OPENROUTER_API_KEY", originalApiKey);
  restoreEnvironment("OPENROUTER_MODEL", originalModel);
});

test("creates and connects the provider and memory through ConversationService", async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  delete process.env.OPENROUTER_MODEL;
  const memory = new MockMemory();
  let openedPath: string | undefined;
  const service = await createChatService({
    memoryPath: "test-memory.sqlite",
    createProvider: () => OpenRouterProvider.fromEnv(),
    openMemory: async (path) => {
      openedPath = path;
      return memory;
    },
  });
  assert.ok(service instanceof ConversationService);
  assert.equal(openedPath, "test-memory.sqlite");
});

test("uses the documented local SQLite path by default", async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  delete process.env.OPENROUTER_MODEL;
  let openedPath: string | undefined;
  await createChatService({
    createProvider: () => OpenRouterProvider.fromEnv(),
    openMemory: async (path) => {
      openedPath = path;
      return new MockMemory();
    },
  });
  assert.equal(openedPath, DEFAULT_MEMORY_PATH);
});

test("reports a missing API key without exposing a key or opening memory", async () => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  let memoryOpened = false;

  await assert.rejects(
    createChatService({
      openMemory: async () => {
        memoryOpened = true;
        return new MockMemory();
      },
    }),
    (error: unknown) =>
      error instanceof OpenRouterConfigurationError &&
      error.message.includes("OPENROUTER_API_KEY") &&
      !error.message.includes("local-test"),
  );
  assert.equal(memoryOpened, false);
});

test("rejects custom providers in the chat factory before opening memory", async () => {
  let memoryOpened = false;
  await assert.rejects(
    createChatService({
      createProvider: () => new MockProvider(),
      openMemory: async () => {
        memoryOpened = true;
        return new MockMemory();
      },
    }),
    OpenRouterConfigurationError,
  );
  assert.equal(memoryOpened, false);
});

test("wires the production OpenRouter provider through the free-only router", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  delete process.env.OPENROUTER_MODEL;
  let requestBody: Record<string, unknown> | undefined;
  const routes: Array<{ provider: string; success: boolean }> = [];
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "four" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const service = await createChatService({
    createProvider: () => OpenRouterProvider.fromEnv(),
    openMemory: async () => new MockMemory(),
    onRoute: (event) => routes.push({ provider: event.provider, success: event.success }),
  });

  assert.equal((await service.respond("What is two plus two?")).text, "four");
  assert.equal(requestBody?.model, OPENROUTER_FREE_ROUTER);
  assert.deepEqual(routes, [{ provider: "openrouter/free", success: true }]);
}));

test("runs messages, related-memory retrieval, explicit save and correction, then exits", async () => withMockFetch(async () => {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  delete process.env.OPENROUTER_MODEL;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Hello from Jarvis" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const memory = new MockMemory();
  const service = await createChatService({
    createProvider: () => OpenRouterProvider.fromEnv(),
    openMemory: async () => memory,
  });
  const output: Array<{ text: string; continueSession: boolean }> = [];
  const lines = async function* (): AsyncGenerator<string> {
    yield "/remember preference reply-language = Arabic";
    yield "Which language should I use?";
    yield "/correct preference:reply-language = English";
    yield "Which language should I use?";
    yield "/exit";
    yield "This line must not be handled";
  };

  await runChat(lines(), service, (text, continueSession) => {
    output.push({ text, continueSession });
  });

  assert.match(output[1].text, /حُفظت المعلومة/);
  assert.equal(output[2].text, "Jarvis: Hello from Jarvis");
  const firstContext = String((requests[0].messages as Array<{ content: string }>)[0].content);
  const secondContext = String((requests[1].messages as Array<{ content: string }>)[0].content);
  assert.match(firstContext, /"value":"Arabic"/);
  assert.match(output[3].text, /صُححت المعلومة/);
  assert.equal(output[4].text, "Jarvis: Hello from Jarvis");
  assert.match(secondContext, /"value":"English"/);
  assert.doesNotMatch(secondContext, /"value":"Arabic"/);
  assert.equal(output.at(-1)?.continueSession, false);
  assert.match(output.at(-1)?.text ?? "", /إلى اللقاء/);
  assert.equal(output.some(({ text }) => text.includes("must not be handled")), false);
}));

test("shows safe provider errors and continues without leaking provider details", async () => {
  const secret = "local-test-secret";
  const service: Pick<ConversationService, "respond"> = {
    respond: async () => {
      throw new Error(`Network failure containing ${secret}`);
    },
  };
  const output: string[] = [];
  const lines = async function* (): AsyncGenerator<string> {
    yield "Hello";
    yield "/exit";
  };

  await runChat(lines(), service, (text) => output.push(text));

  assert.ok(output.some((text) => text.includes("تعذر إكمال الطلب")));
  assert.equal(output.some((text) => text.includes("تحقق من حالة الذاكرة المحلية")), false);
  assert.equal(output.some((text) => text.includes(secret)), false);
  assert.match(output.at(-1) ?? "", /إلى اللقاء/);
});

test("does not display the original OpenRouterError message", async () => {
  const originalMessage = "TEST_PROVIDER_ERROR_SENTINEL";
  const service: Pick<ConversationService, "respond"> = {
    respond: async () => {
      throw new OpenRouterError(originalMessage);
    },
  };
  const output: string[] = [];
  const lines = async function* (): AsyncGenerator<string> {
    yield "Hello";
    yield "/exit";
  };

  await runChat(lines(), service, (text) => output.push(text));

  assert.ok(output.some((text) => text.includes("تعذر الاتصال بمزود الذكاء الاصطناعي")));
  assert.equal(output.some((text) => text.includes(originalMessage)), false);
});

test("hides OpenRouter configuration details when application startup fails", () => {
  const memoryPath = join(tmpdir(), `jarvis-startup-test-${randomUUID()}.sqlite`);
  const env: NodeJS.ProcessEnv = { ...process.env, JARVIS_DB_PATH: memoryPath };
  delete env.OPENROUTER_API_KEY;

  const result = spawnSync(
    process.execPath,
    [join(__dirname, "..", "src", "chat.js")],
    { encoding: "utf8", env, timeout: 5_000 },
  );

  assert.equal(result.error, undefined, "chat process must start and exit normally");
  assert.notEqual(result.status, 0, "missing OpenRouter configuration must fail startup");
  assert.match(
    result.stderr,
    /تعذر تهيئة مزود الذكاء الاصطناعي\. تحقق من الإعدادات وحاول مجدداً\./,
  );
  assert.doesNotMatch(
    result.stderr,
    /OPENROUTER_API_KEY|Set .*local environment/,
    "startup output must not include the original provider error",
  );
  assert.equal(existsSync(memoryPath), false, "provider setup must fail before opening memory");
});

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
