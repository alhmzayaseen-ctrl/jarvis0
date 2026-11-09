import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ConversationService,
  type ConversationMemory,
} from "../src/conversation";
import { ShortTermMemory, WorkingMemory } from "../src/context";
import { HybridModelRouter } from "../src/model-router";
import {
  MemoryConflictError,
  MemoryExistsError,
  type MemoryInput,
  type MemoryRecord,
  MemoryStore,
} from "../src/memory";
import type { AIProvider, AIRequest } from "../src/provider";
import { OpenRouterProvider } from "../src/openrouter";

class MockMemory implements ConversationMemory {
  readonly records = new Map<string, MemoryRecord>();
  readonly revisions = new Map<string, MemoryRecord[]>();
  createCalls = 0;
  searchCalls = 0;
  updateCalls = 0;
  searchFailure?: Error;

  async create(input: MemoryInput): Promise<MemoryRecord> {
    this.createCalls += 1;
    if (this.records.has(input.key)) throw new MemoryExistsError(input.key);
    const now = new Date().toISOString();
    const record = {
      ...input,
      id: `id-${input.key}`,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(input.key, record);
    this.revisions.set(input.key, [record]);
    return record;
  }

  async get(key: string): Promise<MemoryRecord | null> {
    return this.records.get(key) ?? null;
  }

  async search(query: string, limit = 10): Promise<MemoryRecord[]> {
    this.searchCalls += 1;
    if (this.searchFailure) throw this.searchFailure;
    const terms = query.toLowerCase().split(/\W+/u).filter(Boolean);
    return [...this.records.values()]
      .filter((record) =>
        terms.some((term) => `${record.key} ${record.value}`.toLowerCase().includes(term)),
      )
      .slice(0, limit);
  }

  async update(key: string, expectedVersion: number, correction: MemoryInput): Promise<MemoryRecord> {
    this.updateCalls += 1;
    const current = this.records.get(key);
    if (!current || current.version !== expectedVersion) {
      throw new MemoryConflictError(key, expectedVersion, current?.version ?? null);
    }
    const updated = {
      ...correction,
      id: current.id,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, updated);
    this.revisions.get(key)?.push(updated);
    return updated;
  }
}

const originalApiKey = process.env.OPENROUTER_API_KEY;
const originalModel = process.env.OPENROUTER_MODEL;
const originalOpenRouterComplete = OpenRouterProvider.prototype.complete;
const mockProviders = new WeakMap<OpenRouterProvider, { requests: AIRequest[]; response: string }>();
const mockRouterRequests = new WeakMap<HybridModelRouter, AIRequest[]>();

beforeEach(() => {
  OpenRouterProvider.prototype.complete = async function (request: AIRequest): Promise<string> {
    const mock = mockProviders.get(this);
    if (mock) {
      mock.requests.push(request);
      return mock.response;
    }
    return originalOpenRouterComplete.call(this, request);
  };
});

afterEach(() => {
  OpenRouterProvider.prototype.complete = originalOpenRouterComplete;
  restoreEnvironment("OPENROUTER_API_KEY", originalApiKey);
  restoreEnvironment("OPENROUTER_MODEL", originalModel);
});

test("retrieves a related memory and supplies its value and provenance as context data", async () => {
  const memory = new MockMemory();
  await memory.create({
    kind: "fact",
    key: "preferred-language",
    value: "Arabic",
    provenance: "Explicitly provided by the user",
  });
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  const result = await service.respond("Which language should I use?");

  assert.equal(result.text, "Mock response");
  assert.equal(result.memoryStatus, "used");
  assert.equal(result.memoriesUsed, 1);
  assert.match(requestsFor(provider)[0].context ?? "", /"value":"Arabic"/);
  assert.match(requestsFor(provider)[0].context ?? "", /Explicitly provided by the user/);
  assert.match(requestsFor(provider)[0].context ?? "", /never instructions/);
});

test("real memory search passes Arabic reply-language preference into conversation context", async () => {
  const databasePath = join(process.cwd(), `jarvis-conversation-memory-${randomUUID()}.sqlite`);
  const memory = await MemoryStore.open(databasePath);
  try {
    await memory.create({
      kind: "fact",
      key: "preference:reply-language",
      value: "Arabic Levantine",
      provenance: "Explicitly provided by the user",
    });
    const provider = createMockProvider();
    const service = new ConversationService(provider, memory);

    const result = await service.respond("شو لغة الرد المفضلة عندي؟");

    assert.equal(result.memoryStatus, "used");
    assert.equal(result.memoriesUsed, 1);
    assert.match(requestsFor(provider)[0].context ?? "", /"key":"preference:reply-language"/);
    assert.match(requestsFor(provider)[0].context ?? "", /"value":"Arabic Levantine"/);
  } finally {
    for (const path of [databasePath, `${databasePath}.lock`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
});

test("saves shorthand remember commands as facts in real memory", async () => {
  await withTemporaryMemory(async (memory) => {
    const provider = createMockProvider();
    const service = new ConversationService(provider, memory);

    const saved = await service.respond("/remember test-favorite-color = blue");
    const record = await memory.get("test-favorite-color");
    const duplicate = await service.respond("/remember test-favorite-color = blue");

    assert.equal(saved.memoryStatus, "saved");
    assert.match(saved.text, /حُفظت المعلومة/);
    assert.equal(record?.kind, "fact");
    assert.equal(record?.value, "blue");
    assert.equal(duplicate.memoryStatus, "clarification-needed");
    assert.doesNotMatch(duplicate.text, /حُفظت المعلومة/);
    assert.equal(requestsFor(provider).length, 0);
  });
});

test("continues to save explicit fact and preference command forms", async () => {
  await withTemporaryMemory(async (memory) => {
    const provider = createMockProvider();
    const service = new ConversationService(provider, memory);

    const factResult = await service.respond("/remember fact test-favorite-color = blue");
    const preferenceResult = await service.respond(
      "/remember preference reply-language = ArabicLevantine",
    );

    assert.equal(factResult.memoryStatus, "saved");
    assert.equal((await memory.get("test-favorite-color"))?.kind, "fact");
    assert.equal(preferenceResult.memoryStatus, "saved");
    assert.equal((await memory.get("preference:reply-language"))?.value, "ArabicLevantine");
    assert.equal(requestsFor(provider).length, 0);
  });
});

test("rejects malformed remember commands without sending them to the provider", async () => {
  await withTemporaryMemory(async (memory) => {
    const provider = createMockProvider();
    const service = new ConversationService(provider, memory);

    for (const command of [
      "/remember",
      "/remembered key = value",
      "/remember test-favorite-color",
      "/remember = blue",
      "/remember fact = blue",
      "/remember preference reply-language =",
    ]) {
      const result = await service.respond(command);
      assert.equal(result.memoryStatus, "clarification-needed");
      assert.match(result.text, /\/remember key = value/);
    }

    assert.equal(requestsFor(provider).length, 0);
    assert.deepEqual(await memory.list(), []);
  });

  test("rejects malformed /correct commands without sending them to the provider", async () => {
    const memory = new MockMemory();
    const provider = createMockProvider();
    const service = new ConversationService(provider, memory);

    for (const command of [
      "/correct",
      "/correct   ",
      "/correct key_without_equals",
      "/correct = value_without_key",
      "/correct key =",
    ]) {
      const result = await service.respond(command);
      assert.equal(result.memoryStatus, "clarification-needed");
      assert.match(result.text, /\/correct key = value/);
    }

    assert.equal(requestsFor(provider).length, 0);
  });

  test("handles empty LLM responses safely without throwing or crashing", async () => {
    const memory = new MockMemory();
    const provider = createMockProvider("");
    const shortTerm = new ShortTermMemory();
    const service = new ConversationService(provider, memory, { shortTermMemory: shortTerm });

    const result = await service.respond("Hello, how are you?");
    assert.equal(result.text, "لم أتلقَّ إجابة صالحة من النموذج.");
    assert.equal(result.memoryStatus, "none");
  });
});

test("retrieves Arabic test-color memory into real conversation context only", async () => {
  await withTemporaryMemory(async (memory) => {
    await memory.create({
      kind: "fact",
      key: "test-favorite-color",
      value: "blue",
      provenance: "Explicitly provided by the user",
    });
    await memory.create({
      kind: "fact",
      key: "favorite-color",
      value: "green",
      provenance: "A different color memory",
    });
    await memory.create({
      kind: "fact",
      key: "test-result",
      value: "passed",
      provenance: "A different test memory",
    });

    const provider = createMockProvider();
    const service = new ConversationService(provider, memory);
    const arabic = await service.respond("شو لون الاختبار اللي طلبت منك تتذكره؟");

    assert.equal(arabic.memoryStatus, "used");
    assert.match(requestsFor(provider)[0].context ?? "", /"key":"test-favorite-color"/);
    assert.match(requestsFor(provider)[0].context ?? "", /"value":"blue"/);
    assert.doesNotMatch(
      requestsFor(provider)[0].context ?? "",
      /"key":"favorite-color"|"key":"test-result"|"value":"green"|"value":"passed"/,
    );

    const english = await service.respond("What color did I ask you to remember for the test?");
    assert.equal(english.memoryStatus, "used");
    assert.match(requestsFor(provider)[1].context ?? "", /"key":"test-favorite-color"/);
  });
});

test("uses short-term history and task-isolated working memory in subsequent turns", async () => {
  const provider = createMockProvider();
  const memory = new MockMemory();
  const shortTermMemory = new ShortTermMemory();
  const workingMemory = new WorkingMemory();
  workingMemory.set("task-one", "active-goal", "prepare a project outline");
  workingMemory.set("task-two", "active-goal", "separate task data");
  const service = new ConversationService(provider, memory, {
    sessionId: "test-session",
    taskId: "task-one",
    shortTermMemory,
    workingMemory,
  });

  await service.respond("Please plan the first project step.");
  const result = await service.respond("What should I do next?");

  assert.equal(result.taskType, "question");
  assert.match(requestsFor(provider)[1].context ?? "", /Please plan the first project step/);
  assert.match(requestsFor(provider)[1].context ?? "", /Mock response/);
  assert.match(requestsFor(provider)[1].context ?? "", /prepare a project outline/);
  assert.doesNotMatch(requestsFor(provider)[1].context ?? "", /separate task data/);
});

test("does not include unrelated memories or claim absent prior information", async () => {
  const memory = new MockMemory();
  await memory.create({
    kind: "fact",
    key: "favorite-color",
    value: "Blue",
    provenance: "User said so",
  });
  const provider = createMockProvider();
  const result = await new ConversationService(provider, memory).respond("What is my project deadline?");

  assert.equal(result.memoryStatus, "none");
  assert.equal(result.memoriesUsed, undefined);
  assert.doesNotMatch(requestsFor(provider)[0].context ?? "", /favorite-color|Blue/);
  assert.match(requestsFor(provider)[0].context ?? "", /Do not imply that any previous user information is known/);
});

test("explicit correction replaces the active value while preserving revision history", async () => {
  const memory = new MockMemory();
  await memory.create({
    kind: "fact",
    key: "preferred-language",
    value: "English",
    provenance: "User said so",
  });
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  const correction = await service.respond("/correct preferred-language = Arabic");
  const answer = await service.respond("Which language should I use?");

  assert.equal(correction.memoryStatus, "corrected");
  assert.equal(memory.revisions.get("preferred-language")?.length, 2);
  assert.equal(memory.revisions.get("preferred-language")?.[0].value, "English");
  assert.equal(memory.records.get("preferred-language")?.value, "Arabic");
  assert.match(requestsFor(provider)[0].context ?? "", /"value":"Arabic"/);
  assert.doesNotMatch(requestsFor(provider)[0].context ?? "", /"value":"English"/);
  assert.equal(answer.memoryStatus, "used");
});

test("saves only explicitly requested preferences with a user-provided provenance", async () => {
  const memory = new MockMemory();
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  const result = await service.respond("/remember preference reply-language = Arabic");
  const saved = memory.records.get("preference:reply-language");

  assert.equal(result.memoryStatus, "saved");
  assert.equal(saved?.kind, "fact");
  assert.equal(saved?.value, "Arabic");
  assert.equal(saved?.provenance, "Explicitly provided by the user");
  assert.equal(requestsFor(provider).length, 0);
});

test("P-2 regression: corrects saved preferences with /correct preference <key> = <value>", async () => {
  const memory = new MockMemory();
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  // 1. Save new preference
  const saveResult = await service.respond("/remember preference lang = ar");
  assert.equal(saveResult.memoryStatus, "saved");
  assert.equal(memory.records.get("preference:lang")?.value, "ar");
  assert.equal(memory.records.size, 1);

  // 2. Correct preference using symmetrical /correct preference syntax
  const correctResult = await service.respond("/correct preference lang = nl");
  assert.equal(correctResult.memoryStatus, "corrected");
  assert.match(correctResult.text, /preference:lang/);

  // 3. Verify key is preserved without duplicate entries
  const record = memory.records.get("preference:lang");
  assert.ok(record, "preference:lang must remain stored");
  assert.equal(record?.value, "nl");
  assert.equal(record?.version, 2);
  assert.equal(memory.records.has("lang"), false, "must not create a duplicate key named lang");
  assert.equal(memory.records.size, 1, "memory table must have exactly 1 record");

  // 4. Verify revision history is properly tracked
  const revisions = memory.revisions.get("preference:lang");
  assert.equal(revisions?.length, 2);
  assert.equal(revisions?.[0].value, "ar");
  assert.equal(revisions?.[1].value, "nl");

  // 5. Correct preference using short form /correct <key> = <value> fallback
  const shortCorrection = await service.respond("/correct lang = en");
  assert.equal(shortCorrection.memoryStatus, "corrected");
  assert.equal(memory.records.get("preference:lang")?.value, "en");
  assert.equal(memory.records.size, 1);
  assert.equal(memory.revisions.get("preference:lang")?.length, 3);
});

test("P-2 regression: normal memory keys and invalid syntax handling in /correct", async () => {
  const memory = new MockMemory();
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  // Normal memory creation and correction
  await service.respond("/remember fact city = Amsterdam");
  await service.respond("/remember role = engineer");

  const correctCity = await service.respond("/correct fact city = Rotterdam");
  assert.equal(correctCity.memoryStatus, "corrected");
  assert.equal(memory.records.get("city")?.value, "Rotterdam");

  const correctRole = await service.respond("/correct role = lead");
  assert.equal(correctRole.memoryStatus, "corrected");
  assert.equal(memory.records.get("role")?.value, "lead");

  // Reject malformed preference correction commands
  for (const invalid of [
    "/correct preference",
    "/correct preference =",
    "/correct preference = value",
    "/correct preference lang =",
    "/correct fact =",
  ]) {
    const res = await service.respond(invalid);
    assert.equal(res.memoryStatus, "clarification-needed");
    assert.match(res.text, /\/correct key = value/);
  }
});

test("P-2 regression: coexistence of regular fact and preference with same base name", async () => {
  const memory = new MockMemory();
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  // 1. Save normal fact 'lang' and preference 'preference:lang'
  const factSave = await service.respond("/remember fact lang = TypeScript");
  assert.equal(factSave.memoryStatus, "saved");
  const prefSave = await service.respond("/remember preference lang = Arabic");
  assert.equal(prefSave.memoryStatus, "saved");

  assert.equal(memory.records.size, 2);
  assert.equal(memory.records.get("lang")?.value, "TypeScript");
  assert.equal(memory.records.get("preference:lang")?.value, "Arabic");

  // 2. Correct normal fact using '/correct lang = Go'
  const factCorrection = await service.respond("/correct lang = Go");
  assert.equal(factCorrection.memoryStatus, "corrected");
  assert.equal(memory.records.get("lang")?.value, "Go");
  assert.equal(memory.records.get("preference:lang")?.value, "Arabic", "preference must remain untouched");

  // 3. Correct preference using '/correct preference lang = Dutch'
  const prefCorrection = await service.respond("/correct preference lang = Dutch");
  assert.equal(prefCorrection.memoryStatus, "corrected");
  assert.equal(memory.records.get("preference:lang")?.value, "Dutch");
  assert.equal(memory.records.get("lang")?.value, "Go", "regular fact must remain untouched");

  // Verify versions and total records
  assert.equal(memory.records.size, 2);
  assert.equal(memory.records.get("lang")?.version, 2);
  assert.equal(memory.records.get("preference:lang")?.version, 2);
});

test("P-2 regression: saves and corrects goals and projects without duplicates", async () => {
  const memory = new MockMemory();
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  // 1. Goal: save and correct
  const goalSave = await service.respond("/remember goal launch = Q1");
  assert.equal(goalSave.memoryStatus, "saved");
  assert.equal(memory.records.get("launch")?.kind, "goal");
  assert.equal(memory.records.get("launch")?.value, "Q1");

  const goalCorrection = await service.respond("/correct goal launch = Q2");
  assert.equal(goalCorrection.memoryStatus, "corrected");
  assert.equal(memory.records.get("launch")?.value, "Q2");
  assert.equal(memory.records.get("launch")?.version, 2);

  // 2. Project: save and correct
  const projectSave = await service.respond("/remember project jarvis = active");
  assert.equal(projectSave.memoryStatus, "saved");
  assert.equal(memory.records.get("jarvis")?.kind, "project");
  assert.equal(memory.records.get("jarvis")?.value, "active");

  const projectCorrection = await service.respond("/correct project jarvis = maintenance");
  assert.equal(projectCorrection.memoryStatus, "corrected");
  assert.equal(memory.records.get("jarvis")?.value, "maintenance");
  assert.equal(memory.records.get("jarvis")?.version, 2);

  // Verify total count and revision histories
  assert.equal(memory.records.size, 2);
  assert.equal(memory.revisions.get("launch")?.length, 2);
  assert.equal(memory.revisions.get("jarvis")?.length, 2);
});

test("P-2 regression: handles literal key named 'preference' as a fact", async () => {
  const memory = new MockMemory();
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  // 1. Save fact whose key is 'preference'
  const saveResult = await service.respond("/remember fact preference = high");
  assert.equal(saveResult.memoryStatus, "saved");
  assert.equal(memory.records.get("preference")?.kind, "fact");
  assert.equal(memory.records.get("preference")?.value, "high");
  assert.equal(memory.records.size, 1);

  // 2. Correct it with '/correct fact preference = low'
  const correctResult = await service.respond("/correct fact preference = low");
  assert.equal(correctResult.memoryStatus, "corrected");
  assert.equal(memory.records.get("preference")?.value, "low");
  assert.equal(memory.records.get("preference")?.version, 2);

  // Ensure no side-car key like 'preference:preference' was created
  assert.equal(memory.records.has("preference:preference"), false);
  assert.equal(memory.records.size, 1);
  assert.equal(memory.revisions.get("preference")?.length, 2);
});

test("does not save uncertain claims, assumptions, or ordinary conversation automatically", async () => {
  const memory = new MockMemory();
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  const uncertain = await service.respond("/remember fact employer = Maybe Acme");
  const assumption = await service.respond("/remember assumption employer = Acme");
  const temporary = await service.respond("/remember temporary meeting-location = Room 4");
  const task = await service.respond("/remember task submit-report = Tomorrow");
  await service.respond("I think my employer is Acme.");

  assert.equal(uncertain.memoryStatus, "clarification-needed");
  assert.equal(assumption.memoryStatus, "clarification-needed");
  assert.equal(temporary.memoryStatus, "clarification-needed");
  assert.equal(task.memoryStatus, "clarification-needed");
  assert.equal(memory.createCalls, 0);
  assert.equal(memory.records.size, 0);
  assert.equal(requestsFor(provider).length, 1);
});

test("returns and stores an ordinary provider response", async () => {
  const providerOutput = "A normal response.";
  const provider = createMockProvider(providerOutput);
  const shortTermMemory = new ShortTermMemory();
  const sessionId = "ordinary-response-session";
  const service = new ConversationService(provider, new MockMemory(), {
    sessionId,
    shortTermMemory,
  });

  const result = await service.respond("Summarize the current project status.");

  assert.ok(result.text === providerOutput, "ordinary response must reach the caller unchanged");
  assert.equal(result.memoryStatus, "none", "empty memory must report none");
  assert.ok(
    shortTermMemory.recent(sessionId).some(
      (event) => event.role === "assistant" && event.content === providerOutput,
    ),
    "ordinary response must be stored in short-term memory",
  );
});

test("blocks a sensitive provider response without returning or storing it", async () => {
  const providerOutput = `API key is ${"x".repeat(24)}`;
  const provider = createMockProvider(providerOutput);
  const shortTermMemory = new ShortTermMemory();
  const sessionId = "sensitive-response-session";
  const service = new ConversationService(provider, new MockMemory(), {
    sessionId,
    shortTermMemory,
  });

  const result = await service.respond("Summarize the current project status.");

  assert.ok(
    result.text === "تعذر عرض الرد لأسباب تتعلق بالخصوصية.",
    "sensitive response must be replaced with the generic refusal",
  );
  assert.equal(result.memoryStatus, "privacy-blocked", "sensitive response must be privacy-blocked");
  assert.ok(
    shortTermMemory.recent(sessionId).some((event) => event.role === "user"),
    "user message must remain stored even when the response is blocked",
  );
  assert.ok(
    shortTermMemory.recent(sessionId).every(
      (event) => event.role !== "assistant" || event.content !== providerOutput,
    ),
    "sensitive provider response must not be stored",
  );
});

test("blocks secrets and sensitive content, including sensitive stored memories", async () => {
  const memory = new MockMemory();
  await memory.create({
    kind: "fact",
    key: "work-language-health",
    value: "Arabic; I was diagnosed with an example condition",
    provenance: "User disclosure",
  });
  await memory.create({
    kind: "fact",
    key: "preferred-work-language",
    value: "Arabic",
    provenance: "User preference",
  });
  const provider = createMockProvider();
  const service = new ConversationService(provider, memory);

  const secret = await service.respond("My API key is sk-or-test-placeholder-not-a-real-key");
  const health = await service.respond("I need help with my diagnosis.");
  const memoryAnswer = await service.respond("What is my preferred work language?");

  assert.equal(secret.memoryStatus, "privacy-blocked");
  assert.equal(health.memoryStatus, "privacy-blocked");
  assert.equal(requestsFor(provider).length, 1);
  assert.doesNotMatch(requestsFor(provider)[0].context ?? "", /work-language-health|example condition/i);
  assert.match(requestsFor(provider)[0].context ?? "", /"value":"Arabic"/);
  assert.equal(memoryAnswer.memoryStatus, "used");
});

test("blocks private contact details before any provider request", async () => {
  const provider = createMockProvider();
  const service = new ConversationService(provider, new MockMemory());

  const email = await service.respond("Please remember my email is user@example.com.");
  const phone = await service.respond("My phone number is +1 202 555 0142.");
  const political = await service.respond("What do you know about my political views?");
  const password = await service.respond("My password is do-not-send-this-value.");

  assert.equal(email.memoryStatus, "privacy-blocked");
  assert.equal(phone.memoryStatus, "privacy-blocked");
  assert.equal(political.memoryStatus, "privacy-blocked");
  assert.equal(password.memoryStatus, "privacy-blocked");
  assert.equal(requestsFor(provider).length, 0);
});

test("blocks detected sensitive messages before memory retrieval, context, or provider use", async () => {
  const provider = createMockProvider();
  const memory = new MockMemory();
  const shortTermMemory = new ShortTermMemory();
  const sessionId = "multilingual-privacy-session";
  const service = new ConversationService(provider, memory, {
    sessionId,
    shortTermMemory,
  });

  for (const message of [
    "My password is example-secret",
    "Mijn wachtwoord is voorbeeld-geheim",
    "أعاني من السكري",
  ]) {
    const result = await service.respond(message);
    assert.equal(result.memoryStatus, "privacy-blocked", "sensitive input must be blocked");
  }

  assert.equal(memory.searchCalls, 0);
  assert.equal(memory.createCalls, 0);
  assert.equal(requestsFor(provider).length, 0);
  assert.deepEqual(shortTermMemory.recent(sessionId), []);
});

test("blocks sensitive remember and correction commands before changing memory", async () => {
  const provider = createMockProvider();
  const memory = new MockMemory();
  await memory.create({
    kind: "fact",
    key: "preferred-language",
    value: "English",
    provenance: "Explicitly provided by the user",
  });
  memory.searchCalls = 0;
  memory.createCalls = 0;
  const service = new ConversationService(provider, memory);

  for (const command of [
    "/remember password = example-secret",
    "/remember wachtwoord = voorbeeld-geheim",
    "/remember كلمة المرور = مثال-سري",
    "/correct preferred-language = Ik heb diabetes",
  ]) {
    const result = await service.respond(command);
    assert.equal(result.memoryStatus, "privacy-blocked", "sensitive memory command must be blocked");
  }

  assert.equal(memory.createCalls, 0);
  assert.equal(memory.updateCalls, 0);
  assert.equal(memory.records.get("preferred-language")?.value, "English");
  assert.equal(memory.searchCalls, 0);
  assert.equal(requestsFor(provider).length, 0);
});

test("blocks sensitive unsupported and invalid remember commands before parsing", async () => {
  const provider = createMockProvider();
  const memory = new MockMemory();
  const service = new ConversationService(provider, memory);

  for (const command of [
    "/remember task password = example-secret",
    "/remember password is example-secret",
  ]) {
    const result = await service.respond(command);
    assert.equal(result.memoryStatus, "privacy-blocked");
  }

  assert.equal(memory.searchCalls, 0);
  assert.equal(memory.createCalls, 0);
  assert.equal(memory.updateCalls, 0);
  assert.equal(requestsFor(provider).length, 0);
});

test("rejects a custom provider even when it claims to be local", () => {
  let cloudCalls = 0;
  const provider = {
    providerKind: "local",
    complete: async (_request: AIRequest) => {
      cloudCalls += 1;
      return "cloud answer";
    },
  };
  assert.throws(
    () => new ConversationService(provider, new MockMemory()),
    /Only a trusted OpenRouter provider or HybridModelRouter is allowed/,
  );
  assert.equal(cloudCalls, 0);
});

test("continues with the original user message when memory retrieval fails", async () => {
  const memory = new MockMemory();
  memory.searchFailure = new Error("local database unavailable");
  const provider = createMockProvider();

  const result = await new ConversationService(provider, memory).respond("Please explain photosynthesis.");

  assert.equal(result.memoryStatus, "unavailable");
  assert.equal(requestsFor(provider)[0].prompt, "Please explain photosynthesis.");
  assert.match(requestsFor(provider)[0].context ?? "", /No relevant stored memories were retrieved/);
  assert.match(requestsFor(provider)[0].context ?? "", /Memory retrieval is currently unavailable\.$/);
  assert.ok((requestsFor(provider)[0].context ?? "").length <= 8_000);
});

test("enforces configured maxContextChars in fallback when memory retrieval fails", async () => {
  const memory = new MockMemory();
  memory.searchFailure = new Error("local database unavailable");
  const provider = createMockProvider();

  const service = new ConversationService(provider, memory, {
    maxContextChars: 870,
  });

  const result = await service.respond("Please explain photosynthesis.");

  assert.equal(result.memoryStatus, "unavailable");
  const capturedContext = requestsFor(provider)[0].context ?? "";
  assert.match(capturedContext, /Memory retrieval is currently unavailable\.$/);
  assert.ok(
    capturedContext.length <= 870,
    `Context length ${capturedContext.length} exceeded configured budget 870`,
  );
});

test("rejects context character limit too small for base instructions and fallback notice", () => {
  const provider = createMockProvider();
  assert.throws(
    () =>
      new ConversationService(provider, new MockMemory(), {
        maxContextChars: 400,
      }),
    /Context character limit must be an integer of at least/,
  );
});

test("keeps working memory task-isolated when memory retrieval fails", async () => {
  const memory = new MockMemory();
  memory.searchFailure = new Error("local database unavailable");
  const provider = createMockProvider();
  const workingMemory = new WorkingMemory();
  workingMemory.set("task-one", "progress", "TASK_ONE_MARKER");
  workingMemory.set("task-two", "progress", "TASK_TWO_MARKER");
  const service = new ConversationService(provider, memory, {
    taskId: "task-one",
    workingMemory,
  });

  const result = await service.respond("What should I do next?");
  const requests = requestsFor(provider);
  const context = requests[0]?.context ?? "";

  assert.equal(result.memoryStatus, "unavailable");
  assert.equal(requests.length, 1);
  assert.ok(context.includes("TASK_ONE_MARKER"));
  assert.ok(!context.includes("TASK_TWO_MARKER"));
});

test("sanitizes provider failures and emits no key-bearing logs", async () => withMockFetch(async () => {
  const secret = "local-secret-test-key";
  process.env.OPENROUTER_API_KEY = secret;
  delete process.env.OPENROUTER_MODEL;
  globalThis.fetch = async () => {
    throw new Error(`network failure: ${secret}`);
  };
  const provider = OpenRouterProvider.fromEnv();
  const service = new ConversationService(provider, new MockMemory());
  const output: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => output.push(values.map(String).join(" "));

  try {
    await assert.rejects(service.respond("Explain the water cycle."), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(output, []);
}));

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createMockProvider(response = "Mock response"): HybridModelRouter {
  process.env.OPENROUTER_API_KEY = "local-test-key";
  delete process.env.OPENROUTER_MODEL;
  const cloud = OpenRouterProvider.fromEnv();
  const requests: AIRequest[] = [];
  mockProviders.set(cloud, { requests, response });
  const router = new HybridModelRouter({ freeCloudProvider: cloud });
  mockRouterRequests.set(router, requests);
  return router;
}

function requestsFor(router: HybridModelRouter): AIRequest[] {
  return mockRouterRequests.get(router) ?? [];
}

async function withMockFetch<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withTemporaryMemory<T>(
  action: (memory: MemoryStore) => Promise<T>,
): Promise<T> {
  const databasePath = join(process.cwd(), `jarvis-conversation-memory-${randomUUID()}.sqlite`);
  const memory = await MemoryStore.open(databasePath);
  try {
    return await action(memory);
  } finally {
    for (const path of [databasePath, `${databasePath}.lock`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
}
