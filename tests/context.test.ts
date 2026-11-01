import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ShortTermMemory,
  TaskContextBuilder,
  WorkingMemory,
} from "../src/context";
import type { MemoryRecord } from "../src/memory";
import { containsSensitiveContent } from "../src/privacy";

test("short-term memory expires events and enforces a per-session bound", () => {
  let now = 1_000;
  const memory = new ShortTermMemory({
    ttlMs: 100,
    maxEventsPerSession: 2,
    now: () => now,
  });

  memory.append("session-a", "user", "first");
  memory.append("session-a", "assistant", "second");
  memory.append("session-a", "user", "third");
  assert.deepEqual(memory.recent("session-a").map(({ content }) => content), ["second", "third"]);
  assert.deepEqual(memory.recent("session-b"), []);

  now += 101;
  assert.deepEqual(memory.recent("session-a"), []);
});

test("short-term storage bounds sessions and event payload size", () => {
  const memory = new ShortTermMemory({
    maxEventsPerSession: 1,
    maxSessions: 1,
    maxEventChars: 4,
  });
  memory.append("first", "user", "123456");
  assert.equal(memory.recent("first")[0].content, "1234");
  memory.append("second", "user", "kept");
  assert.deepEqual(memory.recent("first"), []);
  assert.equal(memory.recent("second")[0].content, "kept");
});

test("working memory is task-scoped, bounded, and expires temporary values", () => {
  let now = 5_000;
  const memory = new WorkingMemory({
    ttlMs: 50,
    maxItemsPerTask: 2,
    now: () => now,
  });
  memory.set("task-a", "first", "one");
  memory.set("task-a", "second", "two");
  memory.set("task-a", "third", "three");
  memory.set("task-b", "first", "separate");

  assert.deepEqual(memory.list("task-a").map(({ key }) => key), ["second", "third"]);
  assert.equal(memory.get("task-b", "first")?.value, "separate");
  assert.equal(memory.get("task-a", "first"), undefined);

  now += 51;
  assert.deepEqual(memory.list("task-a"), []);
  assert.deepEqual(memory.list("task-b"), []);
});

test("working memory bounds task count and rejects oversized values", () => {
  const memory = new WorkingMemory({
    maxItemsPerTask: 1,
    maxTasks: 1,
    maxValueChars: 4,
  });
  memory.set("task-a", "one", "1234");
  assert.throws(() => memory.set("task-a", "large", "12345"), /character limit/);
  memory.set("task-b", "two", "kept");
  assert.deepEqual(memory.list("task-a"), []);
  assert.equal(memory.get("task-b", "two")?.value, "kept");
});

test("task context is bounded, deduplicated, scoped, and excludes sensitive data", async () => {
  const records = [
    makeRecord("1", "preferred-language", "Arabic"),
    makeRecord("1", "preferred-language", "Arabic"),
    makeRecord("2", "health-note", "Ik heb diabetes"),
  ];
  const shortTerm = new ShortTermMemory();
  shortTerm.append("session", "user", "Earlier safe request");
  shortTerm.append("session", "assistant", "Earlier safe response");
  shortTerm.append("session", "assistant", "Mijn wachtwoord is verborgen");
  const working = new WorkingMemory();
  working.set("task", "current-step", "draft outline");
  working.set("task", "gezondheid", "Ik heb diabetes");

  const context = await new TaskContextBuilder().build({
    query: "How do I implement this?",
    baseInstructions: "Do not invent personal facts.",
    searchMemories: async () => records,
    sessionId: "session",
    taskId: "task",
    shortTermMemory: shortTerm,
    workingMemory: working,
    isSensitive: containsSensitiveContent,
    maxMemories: 5,
    maxContextChars: 2_000,
  });

  assert.equal(context.taskType, "coding");
  assert.deepEqual(context.memoryIds, ["1"]);
  assert.equal(context.memoryCount, 1);
  assert.match(context.text, /Earlier safe request/);
  assert.match(context.text, /Earlier safe response/);
  assert.match(context.text, /draft outline/);
  assert.doesNotMatch(context.text, /health-note|Ik heb diabetes|Mijn wachtwoord|gezondheid/);
});

test("task context defaults to filtering sensitive data from all memory scopes", async () => {
  const shortTerm = new ShortTermMemory();
  shortTerm.append("session", "user", "Earlier safe request");
  shortTerm.append("session", "assistant", "My password is context-secret");
  const working = new WorkingMemory();
  working.set("task", "current-step", "draft outline");
  working.set("task", "health-note", "Ik heb diabetes");

  const context = await new TaskContextBuilder().build({
    query: "How do I implement this?",
    baseInstructions: "Do not invent personal facts.",
    searchMemories: async () => [
      makeRecord("safe", "preferred-language", "Arabic"),
      makeRecord("sensitive", "health-note", "Ik heb diabetes"),
    ],
    sessionId: "session",
    taskId: "task",
    shortTermMemory: shortTerm,
    workingMemory: working,
  });

  assert.deepEqual(context.memoryIds, ["safe"]);
  assert.match(context.text, /"value":"Arabic"/);
  assert.match(context.text, /Earlier safe request/);
  assert.match(context.text, /draft outline/);
  assert.doesNotMatch(
    context.text,
    /health-note|Ik heb diabetes|context-secret|My password/i,
  );
});

test("task context enforces a character limit and classifies non-coding work", async () => {
  const context = await new TaskContextBuilder().build({
    query: "لخص هذه الرسالة",
    baseInstructions: "system",
    searchMemories: async () => [
      makeRecord("long", "long-note", "x".repeat(4_000)),
    ],
    maxContextChars: 256,
  });

  assert.equal(context.taskType, "summarization");
  assert.equal(context.truncated, true);
  assert.ok(context.text.length <= 256);
  assert.deepEqual(context.memoryIds, []);
});

test("rejects a context budget too small to preserve system instructions", async () => {
  await assert.rejects(
    new TaskContextBuilder().build({
      query: "question",
      baseInstructions: "x".repeat(257),
      searchMemories: async () => [],
      maxContextChars: 256,
    }),
    /Base instructions exceed/,
  );
});

function makeRecord(id: string, key: string, value: string): MemoryRecord {
  const timestamp = new Date(0).toISOString();
  return {
    id,
    kind: "fact",
    key,
    value,
    provenance: "synthetic test data",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
