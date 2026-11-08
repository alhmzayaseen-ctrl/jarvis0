import type { AIProvider, AIRequest } from "./provider";
import { containsSensitiveContent } from "./privacy";

export const OPENROUTER_FREE_ROUTER = "openrouter/free";
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_COMPLETION_TOKENS = 256;

export class OpenRouterError extends Error {
  readonly status?: number;

  constructor(message: string, options: { status?: number } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
  }
}

export class OpenRouterConfigurationError extends OpenRouterError {}
export class OpenRouterConnectionError extends OpenRouterError {}
export class OpenRouterTimeoutError extends OpenRouterError {}
export class OpenRouterAPIError extends OpenRouterError {}
export class OpenRouterResponseError extends OpenRouterError {}
export class OpenRouterSensitiveRequestError extends OpenRouterError {}

export interface OpenRouterProviderOptions {
  timeoutMs?: number;
}

const TRUSTED_PROVIDERS = new WeakSet<OpenRouterProvider>();

export class OpenRouterProvider implements AIProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;

  private constructor(
    apiKey: string,
    model: string,
    timeoutMs: number,
  ) {
    this.#apiKey = apiKey;
    this.#model = model;
    this.#timeoutMs = timeoutMs;
    Object.freeze(this);
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return {
      model: this.#model,
      timeoutMs: this.#timeoutMs,
    };
  }

  toJSON(): Record<string, unknown> {
    return {
      model: this.#model,
      timeoutMs: this.#timeoutMs,
    };
  }

  static isTrustedProvider(value: unknown): value is OpenRouterProvider {
    return TRUSTED_PROVIDERS.has(value as OpenRouterProvider);
  }

  static fromEnv(options: OpenRouterProviderOptions = {}): OpenRouterProvider {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey?.trim()) {
      throw new OpenRouterConfigurationError("Set OPENROUTER_API_KEY in the local environment.");
    }

    const configuredModel = process.env.OPENROUTER_MODEL;
    if (configuredModel !== undefined && configuredModel !== OPENROUTER_FREE_ROUTER) {
      throw new OpenRouterConfigurationError(
        `OPENROUTER_MODEL must be "${OPENROUTER_FREE_ROUTER}".`,
      );
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new OpenRouterConfigurationError("timeoutMs must be a positive integer.");
    }

    const provider = new OpenRouterProvider(apiKey.trim(), OPENROUTER_FREE_ROUTER, timeoutMs);
    TRUSTED_PROVIDERS.add(provider);
    return provider;
  }

  async complete(request: AIRequest): Promise<string> {
    if (
      (typeof request.privacyLevel === "string" &&
        request.privacyLevel.trim().toLowerCase() === "sensitive") ||
      containsSensitiveContent(`${request.prompt}\n${request.context ?? ""}`)
    ) {
      throw new OpenRouterSensitiveRequestError(
        "Sensitive requests cannot be sent to OpenRouter.",
      );
    }
    if (typeof request.prompt !== "string" || !request.prompt.trim()) {
      throw new OpenRouterConfigurationError("The prompt must not be empty.");
    }

    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (request.context?.trim()) messages.push({ role: "system", content: request.context });
    messages.push({ role: "user", content: request.prompt });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await globalThis.fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.#model, messages, max_tokens: MAX_COMPLETION_TOKENS }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new OpenRouterAPIError(`OpenRouter returned HTTP ${response.status}.`, { status: response.status });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new OpenRouterTimeoutError("The OpenRouter request timed out.");
        }
        throw new OpenRouterResponseError("OpenRouter returned invalid JSON.");
      }

      return this.readCompletion(payload);
    } catch (error) {
      if (error instanceof OpenRouterError) throw error;
      if (controller.signal.aborted) {
        throw new OpenRouterTimeoutError("The OpenRouter request timed out.");
      }
      throw new OpenRouterConnectionError("Could not connect to OpenRouter.");
    } finally {
      clearTimeout(timeout);
    }
  }

  private readCompletion(payload: unknown): string {
    const data = asRecord(payload);
    const choices = data?.choices;
    const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
    const message = asRecord(firstChoice?.message);
    if (typeof message?.content !== "string") {
      throw new OpenRouterResponseError("OpenRouter response did not contain a text completion.");
    }
    return message.content;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
