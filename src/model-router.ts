import type { TaskType } from "./context";
import { OpenRouterProvider } from "./openrouter";
import type { AIProvider, AIRequest } from "./provider";
import { containsSensitiveContent } from "./privacy";

export interface ModelRouteEvent {
  taskType: TaskType;
  privacyLevel: "normal" | "sensitive";
  importance: "normal" | "high";
  provider: "openrouter/free" | "none";
  reason: string;
  durationMs: number;
  success: boolean;
}

export interface HybridModelRouterOptions {
  freeCloudProvider: AIProvider;
  onRoute?: (event: ModelRouteEvent) => void;
  now?: () => number;
}

const PROTECTED_ROUTERS = new WeakSet<HybridModelRouter>();

export class LocalProviderUnavailableError extends Error {
  constructor() {
    super("Sensitive requests are blocked because no reviewed local provider is available.");
    this.name = "LocalProviderUnavailableError";
  }
}

export class HybridModelRouter implements AIProvider {
  private readonly now: () => number;
  private readonly events: ModelRouteEvent[] = [];
  private readonly freeCloudProvider: OpenRouterProvider;
  private readonly onRoute?: (event: ModelRouteEvent) => void;

  constructor(options: HybridModelRouterOptions) {
    this.now = options.now ?? Date.now;
    if (!OpenRouterProvider.isTrustedProvider(options.freeCloudProvider)) {
      throw new Error("The cloud route must be an OpenRouterProvider configured for openrouter/free.");
    }
    this.freeCloudProvider = options.freeCloudProvider;
    this.onRoute = options.onRoute;
    if (new.target === HybridModelRouter) PROTECTED_ROUTERS.add(this);
    Object.freeze(this);
  }

  static isProtectedRouter(value: unknown): value is HybridModelRouter {
    return typeof value === "object" && value !== null &&
      PROTECTED_ROUTERS.has(value as HybridModelRouter);
  }

  getRouteEvents(): ModelRouteEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  async complete(request: AIRequest): Promise<string> {
    const taskType = request.taskType ?? "general";
    const privacyLevel =
      (typeof request.privacyLevel === "string" &&
        request.privacyLevel.trim().toLowerCase() === "sensitive") ||
      containsSensitiveContent(`${request.prompt}\n${request.context ?? ""}`)
        ? "sensitive"
        : "normal";
    const importance = request.importance ?? "normal";
    const sensitive = privacyLevel === "sensitive";
    const provider = sensitive ? undefined : this.freeCloudProvider;
    const providerType = provider ? "openrouter/free" : "none";
    const reason = sensitive
      ? "Sensitive requests are blocked because no reviewed local provider is available."
      : importance === "high"
        ? "High-importance requests use the only configured cloud route: OpenRouter free router."
        : taskType === "coding"
          ? "Coding request uses the configured free cloud route; no paid or alternate model is eligible."
          : "Request uses the configured free cloud route; no paid or alternate model is eligible.";
    const startedAt = this.now();
    if (!provider) {
      this.record({
        taskType,
        privacyLevel,
        importance,
        provider: providerType,
        reason,
        durationMs: 0,
        success: false,
      });
      throw new LocalProviderUnavailableError();
    }

    let success = false;
    try {
      const result = await provider.complete({ ...request, privacyLevel });
      success = true;
      return result;
    } finally {
      this.record({
        taskType,
        privacyLevel,
        importance,
        provider: providerType,
        reason,
        durationMs: Math.max(0, this.now() - startedAt),
        success,
      });
    }
  }

  private record(event: ModelRouteEvent): void {
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
    try {
      const callbackResult: unknown = this.onRoute?.({ ...event });
      if (isPromiseLike(callbackResult)) {
        void Promise.resolve(callbackResult).catch(() => undefined);
      }
    } catch {
      return;
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
