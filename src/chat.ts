import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { ConversationService, type ConversationResult } from "./conversation";
import { MemoryStore } from "./memory";
import { HybridModelRouter, type ModelRouteEvent } from "./model-router";
import {
  OpenRouterConfigurationError,
  OpenRouterError,
  OpenRouterProvider,
} from "./openrouter";
import type { AIProvider } from "./provider";

export const DEFAULT_MEMORY_PATH = resolve(process.cwd(), "jarvis.sqlite");

export interface ChatDependencies {
  memoryPath?: string;
  createProvider?: () => AIProvider;
  onRoute?: (event: ModelRouteEvent) => void;
  openMemory?: (path: string) => Promise<ConstructorParameters<typeof ConversationService>[1]>;
}

export async function createChatService(
  dependencies: ChatDependencies = {},
): Promise<ConversationService> {
  const configuredProvider = (dependencies.createProvider ?? (() => OpenRouterProvider.fromEnv()))();
  if (!OpenRouterProvider.isTrustedProvider(configuredProvider)) {
    throw new OpenRouterConfigurationError(
      "Only a trusted OpenRouter provider configured for openrouter/free is allowed.",
    );
  }
  const provider = new HybridModelRouter({
    freeCloudProvider: configuredProvider,
    onRoute: dependencies.onRoute,
  });
  const memory = await (dependencies.openMemory ?? ((path) => MemoryStore.open(path)))(
    dependencies.memoryPath ?? DEFAULT_MEMORY_PATH,
  );
  return new ConversationService(provider, memory);
}

export type ChatOutput = (text: string, continueSession: boolean) => void;

export async function runChat(
  lines: AsyncIterable<string>,
  service: Pick<ConversationService, "respond">,
  output: ChatOutput,
): Promise<void> {
  output("Jarvis جاهز. اكتب /exit لإنهاء الجلسة.", true);

  for await (const line of lines) {
    const message = line.trim();
    if (!message) continue;

    if (message === "/exit") {
      output("Jarvis: إلى اللقاء.", false);
      return;
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

function formatResult(result: ConversationResult): string {
  const note =
    result.memoryStatus === "unavailable"
      ? "\n(تعذر الوصول إلى الذاكرة المحلية؛ أُرسل السؤال دون ذكريات سابقة.)"
      : "";
  return `Jarvis: ${result.text}${note}`;
}

function formatError(error: unknown): string {
  if (error instanceof OpenRouterError) return `Jarvis: ${error.message}`;
  return "Jarvis: تعذر إكمال الطلب. تحقق من حالة الذاكرة المحلية ثم أعد المحاولة.";
}

async function main(): Promise<void> {
  let service: ConversationService;
  try {
    service = await createChatService();
  } catch (error) {
    if (error instanceof OpenRouterError) {
      console.error(error.message);
    } else {
      console.error("تعذر تهيئة المحادثة أو فتح الذاكرة المحلية.");
    }
    process.exitCode = 1;
    return;
  }

  const terminal = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    await runChat(terminal, service, (text, continueSession) => {
      process.stdout.write(`${text}\n`);
      if (continueSession) process.stdout.write("You: ");
    });
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
