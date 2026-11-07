import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChatServices } from "../src/chat";
import { WorkingMemory } from "../src/context";
import { MemoryStore } from "../src/memory";
import { OpenRouterProvider } from "../src/openrouter";

interface CapturedRequest {
  messages: Array<{ role: string; content: string }>;
  [key: string]: unknown;
}

test("composes both services over one store and shared working memory", async () => {
  await withChatServices(async ({ runtime, requests, counters, workingMemory }) => {
    const task = await runtime.taskService.createTask({ title: "Shared resources", status: "pending" });
    workingMemory.set(task.id, "goal", "SHARED_TASK_CONTEXT_MARKER");
    const result = await runtime.conversationService.respond("What is the task goal?");
    const request = requests[0];
    const context = request.messages.find(({ role }) => role === "system")?.content ?? "";

    assert.equal(result.text, "Integration response");
    assert.equal(runtime.workingMemory, workingMemory);
    assert.equal(counters.taskCreates, 1);
    assert.equal(counters.memorySearches, 1);
    assert.match(context, /SHARED_TASK_CONTEXT_MARKER/);
    assert.doesNotMatch(JSON.stringify(request), new RegExp(task.id));
    await runtime.taskService.startTask(task.id);
    await runtime.taskService.completeTask(task.id);
    assert.equal(workingMemory.get(task.id, "goal"), undefined);
  });
});

test("keeps one task and working-memory snapshot through a concurrent switch and completion", async () => {
  await withChatServices(async ({ runtime, memoryStore, requests, workingMemory }) => {
    const first = await runtime.taskService.createTask({ title: "First task", status: "pending" });
    workingMemory.set(first.id, "marker", "FIRST_TASK_SNAPSHOT");
    await runtime.taskService.startTask(first.id);
    const second = await runtime.taskService.createTask({ title: "Second task", status: "pending" });
    workingMemory.set(second.id, "marker", "SECOND_TASK_SNAPSHOT");
    await runtime.taskService.selectActiveTask(first.id);

    let signalSearchStarted!: () => void;
    let releaseSearch!: () => void;
    const searchStarted = new Promise<void>((resolve) => { signalSearchStarted = resolve; });
    const blockedSearch = new Promise<void>((resolve) => { releaseSearch = resolve; });
    const search = memoryStore.search.bind(memoryStore);
    let holdNextSearch = true;
    memoryStore.search = async (query, limit) => {
      if (holdNextSearch) {
        holdNextSearch = false;
        signalSearchStarted();
        await blockedSearch;
      }
      return search(query, limit);
    };

    const firstResponse = runtime.conversationService.respond("Continue the first task.");
    await searchStarted;
    await runtime.taskService.selectActiveTask(second.id);
    await runtime.taskService.completeTask(first.id);
    assert.equal(workingMemory.get(first.id, "marker"), undefined);
    releaseSearch();
    await firstResponse;

    const firstContext = requests[0].messages.find(({ role }) => role === "system")?.content ?? "";
    assert.match(firstContext, /FIRST_TASK_SNAPSHOT/);
    assert.doesNotMatch(firstContext, /SECOND_TASK_SNAPSHOT/);

    await runtime.conversationService.respond("Continue the second task.");
    const secondContext = requests[1].messages.find(({ role }) => role === "system")?.content ?? "";
    assert.match(secondContext, /SECOND_TASK_SNAPSHOT/);
    assert.doesNotMatch(secondContext, /FIRST_TASK_SNAPSHOT/);
  });
});

test("uses the task snapshot in fallback and continues normally with no active task", async () => {
  await withChatServices(async ({ runtime, memoryStore, requests, workingMemory }) => {
    const first = await runtime.taskService.createTask({ title: "Fallback task", status: "pending" });
    workingMemory.set(first.id, "marker", "FALLBACK_TASK_SNAPSHOT");
    const second = await runtime.taskService.createTask({ title: "Other task", status: "pending" });
    workingMemory.set(second.id, "marker", "UNRELATED_TASK_CONTEXT");
    await runtime.taskService.selectActiveTask(first.id);

    let signalSearchStarted!: () => void;
    let releaseSearch!: () => void;
    const searchStarted = new Promise<void>((resolve) => { signalSearchStarted = resolve; });
    const blockedSearch = new Promise<void>((resolve) => { releaseSearch = resolve; });
    const search = memoryStore.search.bind(memoryStore);
    let failNextSearch = true;
    memoryStore.search = async (query, limit) => {
      if (failNextSearch) {
        failNextSearch = false;
        signalSearchStarted();
        await blockedSearch;
        throw new Error("temporary retrieval failure");
      }
      return search(query, limit);
    };

    const fallbackResponse = runtime.conversationService.respond("Use the current task context.");
    await searchStarted;
    await runtime.taskService.selectActiveTask(second.id);
    releaseSearch();
    const fallbackResult = await fallbackResponse;
    const fallbackContext = requests[0].messages.find(({ role }) => role === "system")?.content ?? "";

    assert.equal(fallbackResult.memoryStatus, "unavailable");
    assert.match(fallbackContext, /FALLBACK_TASK_SNAPSHOT/);
    assert.doesNotMatch(fallbackContext, /UNRELATED_TASK_CONTEXT/);

    runtime.taskService.clearActiveTask();
    const noTaskResult = await runtime.conversationService.respond("Continue without an active task.");
    const noTaskContext = requests[1].messages.find(({ role }) => role === "system")?.content ?? "";
    assert.equal(noTaskResult.text, "Integration response");
    assert.doesNotMatch(noTaskContext, /FALLBACK_TASK_SNAPSHOT|UNRELATED_TASK_CONTEXT/);
  });
});

interface RuntimeHarness {
  runtime: Awaited<ReturnType<typeof createChatServices>>;
  memoryStore: MemoryStore;
  workingMemory: WorkingMemory;
  requests: CapturedRequest[];
  counters: { taskCreates: number; memorySearches: number };
}

async function withChatServices(action: (harness: RuntimeHarness) => Promise<void>): Promise<void> {
  const databasePath = join(tmpdir(), `jarvis-chat-task-integration-${randomUUID()}.sqlite`);
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousModel = process.env.OPENROUTER_MODEL;
  const previousFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  const counters = { taskCreates: 0, memorySearches: 0 };

  process.env.OPENROUTER_API_KEY = "integration-test-key";
  delete process.env.OPENROUTER_MODEL;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Integration response" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const memoryStore = await MemoryStore.open(databasePath);
    const createTask = memoryStore.createTask.bind(memoryStore);
    const search = memoryStore.search.bind(memoryStore);
    memoryStore.createTask = async (input) => {
      counters.taskCreates += 1;
      return createTask(input);
    };
    memoryStore.search = async (query, limit) => {
      counters.memorySearches += 1;
      return search(query, limit);
    };
    const workingMemory = new WorkingMemory();
    const runtime = await createChatServices({
      memoryPath: databasePath,
      createProvider: () => OpenRouterProvider.fromEnv(),
      openTaskStore: async (path) => {
        assert.equal(path, databasePath);
        return memoryStore;
      },
      workingMemory,
    });
    await action({ runtime, memoryStore, workingMemory, requests, counters });
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previousModel;
    globalThis.fetch = previousFetch;
    for (const path of [databasePath, `${databasePath}.lock`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
}
