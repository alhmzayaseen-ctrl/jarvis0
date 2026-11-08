import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChat } from "../src/chat";
import { MemoryStore } from "../src/memory";
import { TaskService } from "../src/task-service";
import type { ConversationResult, ConversationService } from "../src/conversation";

test("handles task commands locally and preserves ordinary conversation and exit behavior", async () => {
  const databasePath = join(tmpdir(), `jarvis-task-cli-${randomUUID()}.sqlite`);
  try {
    const memoryStore = await MemoryStore.open(databasePath);
    const taskService = new TaskService(memoryStore);
    const responded: string[] = [];
    const conversation = {
      respond: async (message: string): Promise<ConversationResult> => {
        responded.push(message);
        return { text: "Conversation response", memoryStatus: "none" };
      },
    } as Pick<ConversationService, "respond">;
    const output: string[] = [];
    let firstTaskId = "";
    let completedTaskId = "";
    let cancelledTaskId = "";
    let clearedTaskId = "";

    const lines = async function* (): AsyncGenerator<string> {
      yield "/task";
      yield "/task unknown";
      yield "/task create   ";
      yield "/task progress before selection";
      yield "/task create First task";
      firstTaskId = taskService.activeTaskId ?? "";
      yield "/task create Task to complete";
      completedTaskId = taskService.activeTaskId ?? "";
      yield `/task use ${firstTaskId}`;
      yield "/task current";
      yield "/task progress Reviewed implementation";
      yield "/task start";
      yield "/task create Task to cancel";
      cancelledTaskId = taskService.activeTaskId ?? "";
      yield "/task cancel";
      yield `/task use ${completedTaskId}`;
      yield "/task start";
      yield "/task complete";
      yield "/task use missing-task";
      yield `/task use ${completedTaskId}`;
      yield "/task create Task to keep after clear";
      clearedTaskId = taskService.activeTaskId ?? "";
      yield "/task clear";
      yield "/task current";
      yield "/remember preference reply-language = Arabic";
      yield "/correct preference:reply-language = English";
      yield "A normal message without an active task";
      yield "/exit";
      yield "This line must not be processed";
    };

    await runChat(lines(), conversation, (text) => output.push(text), taskService);

    assert.deepEqual(responded, [
      "/remember preference reply-language = Arabic",
      "/correct preference:reply-language = English",
      "A normal message without an active task",
    ]);
    assert.equal(output.some((text) => text.includes("استخدامات المهام:")), true);
    assert.equal(output.some((text) => text.includes("أمر مهمة غير معروف")), true);
    assert.equal(output.some((text) => text.includes("عنوان المهمة مطلوب")), true);
    assert.equal(output.some((text) => text.includes("لا توجد مهمة نشطة")), true);
    assert.equal(output.some((text) => text.includes("تم إنشاء المهمة واختيارها: First task")), true);
    assert.equal(output.some((text) => text.includes("المهمة النشطة الآن: First task")), true);
    assert.equal(output.some((text) => text.includes("تم تسجيل التقدم")), true);
    assert.equal(output.some((text) => text.includes("بدأت المهمة First task")), true);
    assert.equal(output.some((text) => text.includes("أُلغيت المهمة Task to cancel")), true);
    assert.equal(output.some((text) => text.includes("اكتملت المهمة Task to complete")), true);
    assert.equal(output.some((text) => text.includes("المهمة غير موجودة")), true);
    assert.equal(output.some((text) => text.includes("مكتملة أو ملغاة")), true);
    assert.equal(output.some((text) => text.includes("تم مسح اختيار المهمة النشطة")), true);
    assert.equal(output.some((text) => text.includes("إلى اللقاء")), true);
    assert.equal(output.some((text) => text.includes("This line must not be processed")), false);

    assert.equal((await taskService.getTask(firstTaskId))?.status, "in_progress");
    assert.equal((await taskService.getTask(completedTaskId))?.status, "completed");
    assert.equal((await taskService.getTask(cancelledTaskId))?.status, "cancelled");
    assert.equal((await taskService.getTask(clearedTaskId))?.status, "pending");
    assert.deepEqual(
      (await taskService.listTaskEvents(firstTaskId)).map(({ eventType }) => eventType),
      ["progress", "status_changed"],
    );
    assert.equal(taskService.activeTaskId, null);
  } finally {
    for (const path of [databasePath, `${databasePath}.lock`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
});

test("keeps the three-argument runChat call valid and does not forward /task commands", async () => {
  const responded: string[] = [];
  const conversation = {
    respond: async (message: string): Promise<ConversationResult> => {
      responded.push(message);
      return { text: "Conversation response", memoryStatus: "none" };
    },
  } as Pick<ConversationService, "respond">;
  const output: string[] = [];
  const lines = async function* (): AsyncGenerator<string> {
    yield "/task create unsupported here";
    yield "Ordinary three-argument call";
    yield "/exit";
    yield "Ignore after exit";
  };

  await runChat(lines(), conversation, (text) => output.push(text));

  assert.deepEqual(responded, ["Ordinary three-argument call"]);
  assert.equal(output.some((text) => text.includes("إدارة المهام غير متاحة")), true);
  assert.equal(output.some((text) => text.includes("Ignore after exit")), false);
});

test("rejects sensitive task creation and sensitive progress recording in CLI with Arabic message", async () => {
  const databasePath = join(tmpdir(), `jarvis-task-cli-privacy-${randomUUID()}.sqlite`);
  try {
    const memoryStore = await MemoryStore.open(databasePath);
    const taskService = new TaskService(memoryStore);
    const output: string[] = [];
    let safeTaskId = "";

    const conversation = {
      respond: async (_message: string): Promise<ConversationResult> => {
        return { text: "Conversation response", memoryStatus: "none" };
      },
    } as Pick<ConversationService, "respond">;

    const lines = async function* (): AsyncGenerator<string> {
      yield "/task create My password is super-secret-123";
      yield "/task create كلمة المرور: سر-للغاية";
      yield "/task create Safe initial task";
      safeTaskId = taskService.activeTaskId ?? "";
      yield "/task progress API key is sk-or-v1-abcdef1234567890";
      yield "/task progress أعاني من السكري";
      yield "/task progress Safe progress notes";
      yield "/exit";
    };

    await runChat(lines(), conversation, (text) => output.push(text), taskService);

    const privacyRejections = output.filter((text) =>
      text.includes("لم أحفظ محتوى المهمة لأنه قد يتضمن معلومات حساسة أو سراً."),
    );
    assert.equal(privacyRejections.length, 4);

    assert.equal(output.some((text) => text.includes("super-secret-123")), false);
    assert.equal(output.some((text) => text.includes("سر-للغاية")), false);
    assert.equal(output.some((text) => text.includes("sk-or-v1-abcdef1234567890")), false);

    assert.equal(output.some((text) => text.includes("تم إنشاء المهمة واختيارها: Safe initial task")), true);
    assert.equal(output.some((text) => text.includes("تم تسجيل التقدم")), true);

    const safeTask = await taskService.getTask(safeTaskId);
    assert.equal(safeTask?.title, "Safe initial task");

    const events = await taskService.listTaskEvents(safeTaskId);
    assert.equal(events.length, 1);
    assert.equal(events[0].content, "Safe progress notes");
  } finally {
    for (const path of [databasePath, `${databasePath}.lock`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
});
