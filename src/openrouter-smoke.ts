import {
  OpenRouterError,
  OpenRouterProvider,
} from "./openrouter";

async function main(): Promise<void> {
  const provider = OpenRouterProvider.fromEnv();
  const response = await provider.complete({
    prompt: "Reply with exactly: Jarvis OpenRouter connection verified.",
  });
  if (!response.trim()) {
    throw new Error("OpenRouter returned an empty completion.");
  }
  console.log("OpenRouter free-router connection succeeded.");
}

main().catch((error: unknown) => {
  if (error instanceof OpenRouterError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
});
