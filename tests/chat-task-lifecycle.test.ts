import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChatServices, runChat } from "../src/chat";
import { WorkingMemory } from "../src/context";
import { MemoryStore } from "../src/memory";
import { OpenRouterProvider } from "../src/openrouter";

interface CapturedRequest {
  messages: Array<{ role: string; content: string }>;
  [key: string]: unknown;
}

test("runs a complete CLI task lifecycle with isolated working-memory context", async () => {
  await withRuntime(async ({ runtime, requests, workingMemory }) => {
    const output: string[] = [];
    let firstTaskId = "";
    let secondTaskId = "";
    const lines = async function* (): AsyncGenerator<string> {
      yield "/task create First lifecycle task";
      firstTaskId = runtime.taskService.activeTaskId ?? "";
      workingMemory.set(firstTaskId, "note", "LIFECYCLE_FIRST_TASK_ONLY");
      yield "Ask about the first task";

      yield "/task create Second lifecycle task";
      secondTaskId = runtime.taskService.activeTaskId ?? "";
      workingMemory.set(secondTaskId, "note", "LIFECYCLE_SECOND_TASK_ONLY");
      yield "Ask about the second task";

      yield `/task use ${firstTaskId}`;
      yield "Return to the first task";
      yield "/task progress Reviewed the first-task implementation";
      yield "/task start";
      yield "/task complete";
      yield "Continue with no active task";
      yield "/exit";
    };

    await runChat(lines(), runtime.conversationService, (text) => output.push(text), runtime.taskService);

    const firstContext = systemContext(requests[0]);
    const secondContext = systemContext(requests[1]);
    const returnedContext = systemContext(requests[2]);
    const noTaskContext = systemContext(requests[3]);

    assert.match(firstContext, /LIFECYCLE_FIRST_TASK_ONLY/);
    assert.doesNotMatch(firstContext, /LIFECYCLE_SECOND_TASK_ONLY/);
    assert.match(secondContext, /LIFECYCLE_SECOND_TASK_ONLY/);
    assert.doesNotMatch(secondContext, /LIFECYCLE_FIRST_TASK_ONLY/);
    assert.match(returnedContext, /LIFECYCLE_FIRST_TASK_ONLY/);
    assert.doesNotMatch(returnedContext, /LIFECYCLE_SECOND_TASK_ONLY/);
    assert.doesNotMatch(noTaskContext, /LIFECYCLE_FIRST_TASK_ONLY|LIFECYCLE_SECOND_TASK_ONLY/);

    assert.equal(requests.length, 4);
    assert.equal(JSON.stringify(requests).includes("/task "), false);
    assert.equal((await runtime.taskService.getTask(firstTaskId))?.status, "completed");
    assert.equal((await runtime.taskService.getTask(secondTaskId))?.status, "pending");
    assert.deepEqual(
      (await runtime.taskService.listTaskEvents(firstTaskId)).map(({ eventType, content }) => ({ eventType, content })),
      [
        { eventType: "progress", content: "Reviewed the first-task implementation" },
        { eventType: "status_changed", content: "Task status changed from pending to in_progress." },
        { eventType: "status_changed", content: "Task status changed from in_progress to completed." },
      ],
    );
    assert.equal(workingMemory.get(firstTaskId, "note"), undefined);
    assert.equal(workingMemory.get(secondTaskId, "note")?.value, "LIFECYCLE_SECOND_TASK_ONLY");
    assert.equal(runtime.taskService.activeTaskId, null);
    assert.equal(output.some((text) => text.includes("إلى اللقاء")), true);
  });
});

test("keeps an in-flight CLI response on its original task while that task completes", async () => {
  await withRuntime(async ({ runtime, memoryStore, requests, workingMemory }) => {
    const output: string[] = [];
    let firstTaskId = "";
    let secondTaskId = "";
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

    const lines = async function* (): AsyncGenerator<string> {
      yield "/task create In-flight first task";
      firstTaskId = runtime.taskService.activeTaskId ?? "";
      workingMemory.set(firstTaskId, "marker", "IN_FLIGHT_FIRST_TASK");
      yield "/task create Concurrent second task";
      secondTaskId = runtime.taskService.activeTaskId ?? "";
      workingMemory.set(secondTaskId, "marker", "CONCURRENT_SECOND_TASK");
      yield `/task use ${firstTaskId}`;
      yield "/task start";
      yield "Message that remains attached to the first task";
      yield "Next message uses the second task";
      yield "/exit";
    };

    const session = runChat(lines(), runtime.conversationService, (text) => output.push(text), runtime.taskService);
    await searchStarted;
    await runtime.taskService.selectActiveTask(secondTaskId);
    await runtime.taskService.completeTask(firstTaskId);
    assert.equal(workingMemory.get(firstTaskId, "marker"), undefined);
    releaseSearch();
    await session;

    const inFlightContext = systemContext(requests[0]);
    const nextContext = systemContext(requests[1]);
    assert.match(inFlightContext, /IN_FLIGHT_FIRST_TASK/);
    assert.doesNotMatch(inFlightContext, /CONCURRENT_SECOND_TASK/);
    assert.match(nextContext, /CONCURRENT_SECOND_TASK/);
    assert.doesNotMatch(nextContext, /IN_FLIGHT_FIRST_TASK/);
    assert.equal(requests.length, 2);
    assert.equal(JSON.stringify(requests).includes("/task "), false);
    assert.equal((await runtime.taskService.getTask(firstTaskId))?.status, "completed");
    assert.equal(runtime.taskService.activeTaskId, secondTaskId);
    assert.equal(workingMemory.get(secondTaskId, "marker")?.value, "CONCURRENT_SECOND_TASK");
    assert.equal(output.some((text) => text.includes("Second lifecycle task")), false);
  });
});

interface RuntimeHarness {
  runtime: Awaited<ReturnType<typeof createChatServices>>;
  memoryStore: MemoryStore;
  workingMemory: WorkingMemory;
  requests: CapturedRequest[];
}

async function withRuntime(action: (harness: RuntimeHarness) => Promise<void>): Promise<void> {
  const databasePath = join(tmpdir(), `jarvis-chat-task-lifecycle-${randomUUID()}.sqlite`);
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousModel = process.env.OPENROUTER_MODEL;
  const previousFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];

  process.env.OPENROUTER_API_KEY = "lifecycle-test-key";
  delete process.env.OPENROUTER_MODEL;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Lifecycle test response" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const memoryStore = await MemoryStore.open(databasePath);
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
    await action({ runtime, memoryStore, workingMemory, requests });
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

function systemContext(request: CapturedRequest): string {
  return request.messages.find(({ role }) => role === "system")?.content ?? "";
}
