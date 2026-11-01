import type { TaskType } from "./context";

export interface AIRequest {
  prompt: string;
  context?: string;
  taskType?: TaskType;
  privacyLevel?: "normal" | "sensitive";
  importance?: "normal" | "high";
}

export interface AIProvider {
  complete(request: AIRequest): Promise<string>;
}
