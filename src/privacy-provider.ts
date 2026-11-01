import { HybridModelRouter } from "./model-router";
import { OpenRouterProvider } from "./openrouter";
import { containsSensitiveContent } from "./privacy";
import type { AIProvider, AIRequest } from "./provider";

export class SensitiveRequestBlockedError extends Error {
  constructor() {
    super("Sensitive request was blocked because no trusted local route is available.");
    this.name = "SensitiveRequestBlockedError";
  }
}

const PROTECTED_GUARDS = new WeakSet<PrivacyGuardProvider>();

export class PrivacyGuardProvider implements AIProvider {
  constructor(private readonly delegate: AIProvider) {
    if (!HybridModelRouter.isProtectedRouter(delegate)) {
      throw new Error("PrivacyGuardProvider requires a trusted HybridModelRouter.");
    }
    if (new.target === PrivacyGuardProvider) PROTECTED_GUARDS.add(this);
    Object.freeze(this);
  }

  static isProtectedGuard(value: unknown): value is PrivacyGuardProvider {
    return typeof value === "object" && value !== null &&
      PROTECTED_GUARDS.has(value as PrivacyGuardProvider);
  }

  async complete(request: AIRequest): Promise<string> {
    if (isSensitiveRequest(request)) {
      if (HybridModelRouter.isProtectedRouter(this.delegate)) {
        return this.delegate.complete({ ...request, privacyLevel: "sensitive" });
      }
      throw new SensitiveRequestBlockedError();
    }
    return this.delegate.complete({ ...request, privacyLevel: "normal" });
  }
}

export function enforcePrivacyBoundary(provider: AIProvider): AIProvider {
  if (
    PrivacyGuardProvider.isProtectedGuard(provider) ||
    HybridModelRouter.isProtectedRouter(provider)
  ) {
    return provider;
  }
  if (OpenRouterProvider.isTrustedProvider(provider)) {
    return new HybridModelRouter({ freeCloudProvider: provider });
  }
  throw new Error("Only a trusted OpenRouter provider or HybridModelRouter is allowed.");
}

function isSensitiveRequest(request: AIRequest): boolean {
  return (
    request.privacyLevel === "sensitive" ||
    containsSensitiveContent(`${request.prompt}\n${request.context ?? ""}`)
  );
}
