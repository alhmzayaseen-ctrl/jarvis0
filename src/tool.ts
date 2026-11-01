export interface ToolContext {
  requestId: string;
}

export interface Tool<Args = unknown, Result = unknown> {
  readonly name: string;
  execute(args: Args, context: ToolContext): Promise<Result>;
}
