import { WorkingMemory } from "./context";
import { containsSensitiveContent } from "./privacy";
import {
  type TaskEventRecord,
  type TaskInput,
  type TaskRecord,
  type TaskStatus,
  type TaskUpdateInput,
  MemoryStore,
} from "./memory";

type TaskDetailsUpdate = TaskUpdateInput;

export class TaskPrivacyError extends Error {
  constructor(message = "Task content contains sensitive or private information.") {
    super(message);
    this.name = "TaskPrivacyError";
  }
}

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "cancelled"]);

export class TaskService {
  private currentActiveTaskId: string | null = null;
  private transitionQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly workingMemory?: WorkingMemory,
  ) {}

  get activeTaskId(): string | null {
    return this.currentActiveTaskId;
  }

  async createTask(input: TaskInput): Promise<TaskRecord> {
    if (input.status !== "pending") {
      throw new Error("Tasks must be created with pending status.");
    }
    if (
      containsSensitiveContent(input.title) ||
      (input.description && containsSensitiveContent(input.description))
    ) {
      throw new TaskPrivacyError();
    }
    const task = await this.memoryStore.createTask(input);
    this.currentActiveTaskId = task.id;
    return task;
  }

  getTask(taskId: string): Promise<TaskRecord | null> {
    return this.memoryStore.getTask(taskId);
  }

  selectActiveTask(taskId: string): Promise<TaskRecord> {
    return this.serializeTransition(async () => {
      const task = await this.requireTask(taskId);
      if (TERMINAL_STATUSES.has(task.status)) {
        throw new Error("Completed or cancelled tasks cannot be selected as active.");
      }
      this.currentActiveTaskId = task.id;
      return task;
    });
  }

  async getActiveTask(): Promise<TaskRecord | null> {
    return this.currentActiveTaskId
      ? this.memoryStore.getTask(this.currentActiveTaskId)
      : null;
  }

  clearActiveTask(): void {
    // This only changes the in-memory selection; it does not access MemoryStore.
    this.currentActiveTaskId = null;
  }

  async updateTask(taskId: string, input: TaskDetailsUpdate): Promise<TaskRecord> {
    if ("status" in input) {
      throw new Error("Use startTask, completeTask, or cancelTask to change task status.");
    }
    if (
      (input.title !== undefined && containsSensitiveContent(input.title)) ||
      (input.description && containsSensitiveContent(input.description))
    ) {
      throw new TaskPrivacyError();
    }
    // Status changes must use addTaskEvent() so the transition has a durable event.
    return this.memoryStore.updateTask(taskId, input);
  }

  async recordProgress(taskId: string, content: string): Promise<TaskEventRecord> {
    if (containsSensitiveContent(content)) {
      throw new TaskPrivacyError();
    }
    return this.serializeTransition(async () => {
      const task = await this.requireTask(taskId);
      if (TERMINAL_STATUSES.has(task.status)) {
        throw new Error("Progress cannot be recorded for a completed or cancelled task.");
      }
      return this.memoryStore.addTaskEvent({
        taskId,
        eventType: "progress",
        content,
        expectedStatus: task.status,
      });
    });
  }

  startTask(taskId: string): Promise<TaskRecord> {
    return this.serializeTransition(() =>
      this.transitionTask(taskId, "in_progress", ["pending"]),
    );
  }

  completeTask(taskId: string): Promise<TaskRecord> {
    return this.serializeTransition(() =>
      this.transitionTask(taskId, "completed", ["in_progress"], true),
    );
  }

  cancelTask(taskId: string): Promise<TaskRecord> {
    return this.serializeTransition(() =>
      this.transitionTask(taskId, "cancelled", ["pending", "in_progress"], true),
    );
  }

  async listTaskEvents(taskId: string): Promise<TaskEventRecord[]> {
    await this.requireTask(taskId);
    return this.memoryStore.listTaskEvents(taskId);
  }

  private async transitionTask(
    taskId: string,
    nextStatus: TaskStatus,
    allowedCurrentStatuses: TaskStatus[],
    clearTaskMemory = false,
  ): Promise<TaskRecord> {
    const task = await this.requireTask(taskId);
    if (!allowedCurrentStatuses.includes(task.status)) {
      throw new Error(`Cannot transition task from ${task.status} to ${nextStatus}.`);
    }

    const event = await this.memoryStore.addTaskEvent({
      taskId,
      eventType: "status_changed",
      content: `Task status changed from ${task.status} to ${nextStatus}.`,
      status: nextStatus,
      expectedStatus: task.status,
    });

    if (clearTaskMemory) {
      if (this.currentActiveTaskId === taskId) this.currentActiveTaskId = null;
      this.workingMemory?.clear(taskId);
    }

    return { ...task, status: nextStatus, updatedAt: event.createdAt };
  }

  private async requireTask(taskId: string): Promise<TaskRecord> {
    const task = await this.memoryStore.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    return task;
  }

  private serializeTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionQueue.then(operation, operation);
    this.transitionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
