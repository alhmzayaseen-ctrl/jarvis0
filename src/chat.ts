import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { ConversationService, type ConversationResult } from "./conversation";
import { WorkingMemory } from "./context";
import { MemoryStore } from "./memory";
import { HybridModelRouter, type ModelRouteEvent } from "./model-router";
import { TaskPrivacyError, TaskService } from "./task-service";
import {
  OpenRouterConfigurationError,
  OpenRouterError,
  OpenRouterProvider,
} from "./openrouter";
import type { AIProvider } from "./provider";

export const DEFAULT_MEMORY_PATH = process.env.JARVIS_DB_PATH
  ? resolve(process.env.JARVIS_DB_PATH)
  : join(homedir(), ".jarvis", "jarvis.sqlite");

export interface ChatDependencies {
  memoryPath?: string;
  createProvider?: () => AIProvider;
  onRoute?: (event: ModelRouteEvent) => void;
  openMemory?: (path: string) => Promise<ConstructorParameters<typeof ConversationService>[1]>;
}

export interface ChatServicesDependencies {
  memoryPath?: string;
  createProvider?: () => AIProvider;
  onRoute?: (event: ModelRouteEvent) => void;
  openTaskStore?: (path: string) => Promise<MemoryStore>;
  workingMemory?: WorkingMemory;
}

export interface ChatServices {
  conversationService: ConversationService;
  taskService: TaskService;
  workingMemory: WorkingMemory;
}

export async function createChatService(
  dependencies: ChatDependencies = {},
): Promise<ConversationService> {
  const provider = createRoutedProvider(dependencies);
  const memory = await (dependencies.openMemory ?? ((path) => MemoryStore.open(path)))(
    dependencies.memoryPath ?? DEFAULT_MEMORY_PATH,
  );
  return new ConversationService(provider, memory);
}

export async function createChatServices(
  dependencies: ChatServicesDependencies = {},
): Promise<ChatServices> {
  const provider = createRoutedProvider(dependencies);
  const memoryStore = await (dependencies.openTaskStore ?? ((path) => MemoryStore.open(path)))(
    dependencies.memoryPath ?? DEFAULT_MEMORY_PATH,
  );
  const workingMemory = dependencies.workingMemory ?? new WorkingMemory();
  const taskService = new TaskService(memoryStore, workingMemory);
  const conversationService = new ConversationService(provider, memoryStore, {
    workingMemory,
    getTaskId: () => taskService.activeTaskId,
  });

  return { conversationService, taskService, workingMemory };
}

function createRoutedProvider(
  dependencies: Pick<ChatDependencies, "createProvider" | "onRoute">,
): HybridModelRouter {
  const configuredProvider = (dependencies.createProvider ?? (() => OpenRouterProvider.fromEnv()))();
  if (!OpenRouterProvider.isTrustedProvider(configuredProvider)) {
    throw new OpenRouterConfigurationError(
      "Only a trusted OpenRouter provider configured for openrouter/free is allowed.",
    );
  }
  return new HybridModelRouter({
    freeCloudProvider: configuredProvider,
    onRoute: dependencies.onRoute,
  });
}

export type ChatOutput = (text: string, continueSession: boolean) => void;

const TASK_USAGE =
  "استخدامات المهام: /task create <title> | /task use <id> | /task current | /task progress <text> | /task start | /task complete | /task cancel | /task clear";

export async function runChat(
  lines: AsyncIterable<string>,
  service: Pick<ConversationService, "respond">,
  output: ChatOutput,
  taskService?: TaskService,
): Promise<void> {
  output("Jarvis جاهز. اكتب /exit لإنهاء الجلسة.", true);

  for await (const line of lines) {
    const message = line.trim();
    if (!message) continue;

    if (message === "/exit") {
      output("Jarvis: إلى اللقاء.", false);
      return;
    }

    if (/^\/task(?:\s|$)/.test(message)) {
      if (!taskService) {
        output("Jarvis: إدارة المهام غير متاحة في هذه الجلسة.", true);
        continue;
      }
      try {
        const response = await handleTaskCommand(message, taskService);
        output(`Jarvis: ${response}`, true);
      } catch (error) {
        output(`Jarvis: ${formatTaskCommandError(error)}`, true);
      }
      continue;
    }

    try {
      const result = await service.respond(message);
      output(formatResult(result), true);
    } catch (error) {
      output(formatError(error), true);
    }
  }

  output("انتهت الجلسة.", false);
}

async function handleTaskCommand(message: string, taskService: TaskService): Promise<string> {
  const commandText = message.slice("/task".length).trim();
  if (!commandText) return TASK_USAGE;

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(commandText);
  if (!match) return TASK_USAGE;
  const [, command, rawArgument = ""] = match;
  const argument = rawArgument.trim();

  switch (command) {
    case "create": {
      if (!argument) throw new TaskCommandError("عنوان المهمة مطلوب. الاستخدام: /task create <title>.");
      const task = await taskService.createTask({ title: argument, status: "pending" });
      return `تم إنشاء المهمة واختيارها: ${task.title} (ID: ${task.id}) — الحالة: ${task.status}.`;
    }
    case "use": {
      if (!argument || /\s/.test(argument)) {
        throw new TaskCommandError("معرّف المهمة مطلوب. الاستخدام: /task use <id>.");
      }
      const task = await taskService.selectActiveTask(argument);
      return `المهمة النشطة الآن: ${task.title} (ID: ${task.id}) — الحالة: ${task.status}.`;
    }
    case "current": {
      requireNoTaskArgument(argument);
      const task = await taskService.getActiveTask();
      return task
        ? `المهمة النشطة: ${task.title} (ID: ${task.id}) — الحالة: ${task.status}.`
        : "لا توجد مهمة نشطة.";
    }
    case "progress": {
      if (!argument) throw new TaskCommandError("نص التقدم مطلوب. الاستخدام: /task progress <text>.");
      const task = await requireActiveTask(taskService);
      const event = await taskService.recordProgress(task.id, argument);
      return `تم تسجيل التقدم للمهمة ${task.id} (الحدث: ${event.id}).`;
    }
    case "start": {
      requireNoTaskArgument(argument);
      const task = await requireActiveTask(taskService);
      const updated = await taskService.startTask(task.id);
      return `بدأت المهمة ${updated.title} (ID: ${updated.id}) — الحالة: ${updated.status}.`;
    }
    case "complete": {
      requireNoTaskArgument(argument);
      const task = await requireActiveTask(taskService);
      const updated = await taskService.completeTask(task.id);
      return `اكتملت المهمة ${updated.title} (ID: ${updated.id}) — الحالة: ${updated.status}.`;
    }
    case "cancel": {
      requireNoTaskArgument(argument);
      const task = await requireActiveTask(taskService);
      const updated = await taskService.cancelTask(task.id);
      return `أُلغيت المهمة ${updated.title} (ID: ${updated.id}) — الحالة: ${updated.status}.`;
    }
    case "clear": {
      requireNoTaskArgument(argument);
      if (!taskService.activeTaskId) return "لا توجد مهمة نشطة لمسح اختيارها.";
      taskService.clearActiveTask();
      return "تم مسح اختيار المهمة النشطة دون حذف المهمة.";
    }
    default:
      throw new TaskCommandError(`أمر مهمة غير معروف: ${command}. ${TASK_USAGE}`);
  }
}

async function requireActiveTask(taskService: TaskService) {
  const task = await taskService.getActiveTask();
  if (!task) {
    throw new TaskCommandError("لا توجد مهمة نشطة. أنشئ مهمة أو اخترها باستخدام /task use <id>.");
  }
  return task;
}

function requireNoTaskArgument(argument: string): void {
  if (argument) throw new TaskCommandError(`هذا الأمر لا يقبل وسيطاً. ${TASK_USAGE}`);
}

function formatTaskCommandError(error: unknown): string {
  if (error instanceof TaskCommandError) return error.message;
  if (error instanceof TaskPrivacyError) {
    return "لم أحفظ محتوى المهمة لأنه قد يتضمن معلومات حساسة أو سراً.";
  }
  if (!(error instanceof Error)) return "تعذر تنفيذ أمر المهمة.";
  if (error.message === "Task not found.") return "المهمة غير موجودة.";
  if (error.message === "Completed or cancelled tasks cannot be selected as active.") {
    return "لا يمكن اختيار مهمة مكتملة أو ملغاة.";
  }
  if (error.message.startsWith("Cannot transition task from ")) {
    return "لا يسمح بانتقال المهمة من حالتها الحالية.";
  }
  if (error.message === "Progress cannot be recorded for a completed or cancelled task.") {
    return "لا يمكن تسجيل تقدم لمهمة مكتملة أو ملغاة.";
  }
  return "تعذر تنفيذ أمر المهمة. تحقق من المدخلات وحالة المهمة.";
}

class TaskCommandError extends Error {}

function formatResult(result: ConversationResult): string {
  const note =
    result.memoryStatus === "unavailable"
      ? "\n(تعذر الوصول إلى الذاكرة المحلية؛ أُرسل السؤال دون ذكريات سابقة.)"
      : "";
  return `Jarvis: ${result.text}${note}`;
}

function formatError(error: unknown): string {
  if (error instanceof OpenRouterError) {
    return "Jarvis: تعذر الاتصال بمزود الذكاء الاصطناعي. تحقق من الاتصال وحاول مجدداً.";
  }
  return "Jarvis: تعذر إكمال الطلب. حدث خطأ أثناء معالجة رسالتك، حاول مجدداً.";
}

async function main(): Promise<void> {
  let services: ChatServices;
  try {
    services = await createChatServices();
  } catch (error) {
    if (error instanceof OpenRouterError) {
      console.error("تعذر تهيئة مزود الذكاء الاصطناعي. تحقق من الإعدادات وحاول مجدداً.");
    } else {
      console.error("تعذر تهيئة المحادثة أو فتح الذاكرة المحلية.");
    }
    process.exitCode = 1;
    return;
  }

  const terminal = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    await runChat(terminal, services.conversationService, (text, continueSession) => {
      process.stdout.write(`${text}\n`);
      if (continueSession) process.stdout.write("You: ");
    }, services.taskService);
  } finally {
    terminal.close();
  }
}

if (require.main === module) {
  void main().catch(() => {
    console.error("تعذر تشغيل المحادثة.");
    process.exitCode = 1;
  });
}
