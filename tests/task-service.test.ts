import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkingMemory } from "../src/context";
import { MemoryStore } from "../src/memory";
import { TaskService } from "../src/task-service";

test("creates a task, selects it automatically, and retrieves it", async () => {
  await withTaskService(async ({ service }) => {
    const task = await service.createTask({ title: "Plan release", status: "pending" });

    assert.equal(service.activeTaskId, task.id);
    assert.deepEqual(await service.getActiveTask(), task);
    assert.deepEqual(await service.getTask(task.id), task);
  });
});

test("rejects creating an in-progress task before persisting it", async () => {
  await withTaskService(async ({ memoryStore, service }) => {
    let createCalls = 0;
    const createTask = memoryStore.createTask.bind(memoryStore);
    memoryStore.createTask = async (input) => {
      createCalls += 1;
      return createTask(input);
    };

    await assert.rejects(
      service.createTask({ title: "Must remain uncreated", status: "in_progress" }),
      /Tasks must be created with pending status/,
    );

    assert.equal(createCalls, 0);
    assert.equal(service.activeTaskId, null);
  });
});

test("selects and switches tasks without changing statuses or clearing working memory", async () => {
  await withTaskService(async ({ service, workingMemory }) => {
    const first = await service.createTask({ title: "First task", status: "pending" });
    workingMemory.set(first.id, "progress", "first-task-progress");
    const second = await service.createTask({ title: "Second task", status: "pending" });
    workingMemory.set(first.id, "progress", "first-task-progress");
    workingMemory.set(second.id, "progress", "second-task-progress");

    const selected = await service.selectActiveTask(first.id);
    assert.equal(selected.status, "pending");
    assert.equal(service.activeTaskId, first.id);
    assert.equal((await service.getActiveTask())?.id, first.id);

    await service.selectActiveTask(second.id);
    assert.equal(service.activeTaskId, second.id);
    assert.equal((await service.getTask(second.id))?.status, "pending");
    assert.equal(workingMemory.get(first.id, "progress")?.value, "first-task-progress");
    assert.equal(workingMemory.get(second.id, "progress")?.value, "second-task-progress");

    service.clearActiveTask();
    assert.equal(service.activeTaskId, null);
    assert.equal(await service.getActiveTask(), null);
    assert.equal(workingMemory.get(first.id, "progress")?.value, "first-task-progress");
  });
});

test("rejects selecting missing, completed, and cancelled tasks", async () => {
  await withTaskService(async ({ service }) => {
    const previousActive = await service.createTask({ title: "Current task", status: "pending" });
    await service.selectActiveTask(previousActive.id);
    await assert.rejects(service.selectActiveTask("missing-task"), /Task not found/);
    assert.equal(service.activeTaskId, previousActive.id);

    const completed = await service.createTask({ title: "Complete me", status: "pending" });
    await service.startTask(completed.id);
    await service.completeTask(completed.id);
    await assert.rejects(service.selectActiveTask(completed.id), /cannot be selected as active/);

    const cancelled = await service.createTask({ title: "Cancel me", status: "pending" });
    await service.cancelTask(cancelled.id);
    await assert.rejects(service.selectActiveTask(cancelled.id), /cannot be selected as active/);
  });
});

test("updates task details without bypassing lifecycle event recording", async () => {
  await withTaskService(async ({ service }) => {
    const task = await service.createTask({ title: "Draft", status: "pending" });
    const updated = await service.updateTask(task.id, {
      title: "Final draft",
      description: "Updated details",
    });

    assert.equal(updated.title, "Final draft");
    assert.equal(updated.description, "Updated details");
    assert.equal(updated.status, "pending");
    assert.deepEqual(await service.listTaskEvents(task.id), []);

    const attemptedStatusUpdate = { title: "Must not change", status: "completed" as const };
    await assert.rejects(
      service.updateTask(task.id, attemptedStatusUpdate),
      /Use startTask, completeTask, or cancelTask/,
    );
    assert.equal((await service.getTask(task.id))?.status, "pending");
    assert.equal((await service.getTask(task.id))?.title, "Final draft");
    assert.deepEqual(await service.listTaskEvents(task.id), []);
  });
});

test("records task progress and retrieves its event", async () => {
  await withTaskService(async ({ service }) => {
    const task = await service.createTask({ title: "Implement feature", status: "pending" });
    const event = await service.recordProgress(task.id, "Reviewed the current implementation");

    assert.equal(event.taskId, task.id);
    assert.equal(event.eventType, "progress");
    assert.equal(event.content, "Reviewed the current implementation");
    assert.deepEqual(await service.listTaskEvents(task.id), [event]);
  });
});

test("starts a task and records the status event without coupling active selection", async () => {
  await withTaskService(async ({ service }) => {
    const task = await service.createTask({ title: "Start me", status: "pending" });
    const started = await service.startTask(task.id);

    assert.equal(started.status, "in_progress");
    assert.equal(service.activeTaskId, task.id);
    assert.deepEqual(
      (await service.listTaskEvents(task.id)).map(({ eventType, content }) => ({ eventType, content })),
      [{ eventType: "status_changed", content: "Task status changed from pending to in_progress." }],
    );
  });
});

test("rejects invalid lifecycle transitions and does not reopen terminal tasks", async () => {
  await withTaskService(async ({ service }) => {
    const task = await service.createTask({ title: "Transition checks", status: "pending" });
    await assert.rejects(service.completeTask(task.id), /Cannot transition task from pending to completed/);

    await service.startTask(task.id);
    await assert.rejects(service.startTask(task.id), /Cannot transition task from in_progress to in_progress/);
    await service.completeTask(task.id);
    await assert.rejects(service.startTask(task.id), /Cannot transition task from completed to in_progress/);
    await assert.rejects(service.cancelTask(task.id), /Cannot transition task from completed to cancelled/);
    assert.equal((await service.getTask(task.id))?.status, "completed");
  });
});

test("serializes conflicting transitions across independent task services", async () => {
  await withTaskService(async ({ databasePath, memoryStore, service }) => {
    const task = await service.createTask({ title: "Competing transitions", status: "pending" });
    const secondStore = await MemoryStore.open(databasePath);
    const secondService = new TaskService(secondStore);

    let releaseBothReads!: () => void;
    const bothReadsComplete = new Promise<void>((resolve) => { releaseBothReads = resolve; });
    let readCount = 0;
    const firstGetTask = memoryStore.getTask.bind(memoryStore);
    const secondGetTask = secondStore.getTask.bind(secondStore);
    memoryStore.getTask = async (taskId) => {
      const result = await firstGetTask(taskId);
      if (taskId === task.id) {
        readCount += 1;
        if (readCount === 2) releaseBothReads();
        await bothReadsComplete;
      }
      return result;
    };
    secondStore.getTask = async (taskId) => {
      const result = await secondGetTask(taskId);
      if (taskId === task.id) {
        readCount += 1;
        if (readCount === 2) releaseBothReads();
        await bothReadsComplete;
      }
      return result;
    };

    let signalStartAttempt!: () => void;
    const startAttemptReachedStorage = new Promise<void>((resolve) => { signalStartAttempt = resolve; });
    let releaseStartAttempt!: () => void;
    const holdStartAttempt = new Promise<void>((resolve) => { releaseStartAttempt = resolve; });
    const addTaskEvent = memoryStore.addTaskEvent.bind(memoryStore);
    memoryStore.addTaskEvent = async (input) => {
      if (input.status === "in_progress") {
        signalStartAttempt();
        await holdStartAttempt;
      }
      return addTaskEvent(input);
    };

    const startAttempt = service.startTask(task.id);
    const cancelAttempt = secondService.cancelTask(task.id);
    await startAttemptReachedStorage;
    const cancelled = await cancelAttempt;
    releaseStartAttempt();
    const results = await Promise.allSettled([startAttempt, cancelAttempt]);

    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = results.find(({ status }) => status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.match(rejected.reason.message, /expected pending, found cancelled/);
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await memoryStore.getTask(task.id))?.status, "cancelled");
    assert.deepEqual(
      (await memoryStore.listTaskEvents(task.id)).map(({ eventType, content }) => ({ eventType, content })),
      [{ eventType: "status_changed", content: "Task status changed from pending to cancelled." }],
    );
  });
});

test("completes a task, records the event, and clears only its working memory", async () => {
  await withTaskService(async ({ service, workingMemory }) => {
    const completed = await service.createTask({ title: "Complete me", status: "pending" });
    await service.startTask(completed.id);
    const other = await service.createTask({ title: "Keep this task", status: "pending" });
    workingMemory.set(completed.id, "progress", "completed-task-data");
    workingMemory.set(other.id, "progress", "other-task-data");

    const result = await service.completeTask(completed.id);
    assert.equal(result.status, "completed");
    assert.equal(service.activeTaskId, other.id);
    assert.equal(workingMemory.get(completed.id, "progress"), undefined);
    assert.equal(workingMemory.get(other.id, "progress")?.value, "other-task-data");
    assert.equal((await service.listTaskEvents(completed.id)).at(-1)?.content,
      "Task status changed from in_progress to completed.");
  });
});

test("cancels a task and clears only its working memory", async () => {
  await withTaskService(async ({ service, workingMemory }) => {
    const cancelled = await service.createTask({ title: "Cancel me", status: "pending" });
    const other = await service.createTask({ title: "Keep this task", status: "pending" });
    workingMemory.set(cancelled.id, "progress", "cancelled-task-data");
    workingMemory.set(other.id, "progress", "other-task-data");
    await service.selectActiveTask(cancelled.id);

    const result = await service.cancelTask(cancelled.id);
    assert.equal(result.status, "cancelled");
    assert.equal(service.activeTaskId, null);
    assert.equal(workingMemory.get(cancelled.id, "progress"), undefined);
    assert.equal(workingMemory.get(other.id, "progress")?.value, "other-task-data");
    assert.equal((await service.listTaskEvents(cancelled.id))[0]?.content,
      "Task status changed from pending to cancelled.");
  });
});

test("task lifecycle operations do not change long-term memories", async () => {
  await withTaskService(async ({ memoryStore, service }) => {
    const memory = await memoryStore.create({
      kind: "fact",
      key: "task-service-regression",
      value: "preserved long-term record",
      provenance: "test fixture",
    });
    const task = await service.createTask({ title: "Isolated task", status: "pending" });
    await service.startTask(task.id);
    await service.recordProgress(task.id, "Progress note");
    await service.completeTask(task.id);

    assert.deepEqual(await memoryStore.get(memory.key), memory);
    assert.deepEqual(await memoryStore.history(memory.key), [{ ...memory, revision: 1 }]);
  });
});

interface TestDependencies {
  databasePath: string;
  memoryStore: MemoryStore;
  service: TaskService;
  workingMemory: WorkingMemory;
}

async function withTaskService(action: (dependencies: TestDependencies) => Promise<void>): Promise<void> {
  const databasePath = join(tmpdir(), `jarvis-task-service-tests-${randomUUID()}.sqlite`);
  try {
    const memoryStore = await MemoryStore.open(databasePath);
    const workingMemory = new WorkingMemory();
    await action({
      databasePath,
      memoryStore,
      workingMemory,
      service: new TaskService(memoryStore, workingMemory),
    });
  } finally {
    for (const path of [databasePath, `${databasePath}.lock`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
}
