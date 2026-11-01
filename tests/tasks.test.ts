import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

interface WorkspaceTask {
  label: string;
  type: string;
  command: string;
  args?: string[];
  options?: {
    cwd?: string;
    shell?: {
      executable?: string;
      args?: string[];
    };
    env?: Record<string, string>;
  };
}

interface TasksConfiguration {
  tasks: WorkspaceTask[];
  inputs: Array<{
    id: string;
    type: string;
    password?: boolean;
  }>;
}

test("OpenRouter live task uses hidden local key input and runs only the free-router test", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), ".vscode", "tasks.json"), "utf8"),
  ) as TasksConfiguration;
  const task = config.tasks.find(({ label }) => label === "Check OpenRouter connection (free only)");
  assert.ok(task);

  assert.equal(task.type, "shell");
  assert.equal(task.command, "npm.cmd");
  assert.deepEqual(task.args, ["run", "openrouter:live-test"]);
  assert.equal(task.options?.cwd, "${workspaceFolder}");
  assert.equal(task.options?.shell?.executable, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(task.options?.shell?.args, ["/d", "/c"]);
  assert.equal(task.options?.env?.OPENROUTER_API_KEY, "${input:openrouterApiKey}");

  const keyInput = config.inputs.find(({ id }) => id === "openrouterApiKey");
  assert.ok(keyInput);
  assert.equal(keyInput.type, "promptString");
  assert.equal(keyInput.password, true);
});

test("Jarvis chat task passes the hidden key only to the project-local chat process", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), ".vscode", "tasks.json"), "utf8"),
  ) as TasksConfiguration;
  const task = config.tasks.find(({ label }) => label === "Run Jarvis chat (free only)");
  assert.ok(task);

  assert.equal(task.type, "shell");
  assert.equal(task.command, "npm.cmd");
  assert.deepEqual(task.args, ["run", "chat"]);
  assert.equal(task.options?.cwd, "${workspaceFolder}");
  assert.equal(task.options?.shell?.executable, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(task.options?.shell?.args, ["/d", "/c"]);
  assert.equal(task.options?.env?.OPENROUTER_API_KEY, "${input:openrouterApiKey}");

  const keyInput = config.inputs.find(({ id }) => id === "openrouterApiKey");
  assert.ok(keyInput);
  assert.equal(keyInput.type, "promptString");
  assert.equal(keyInput.password, true);
});
