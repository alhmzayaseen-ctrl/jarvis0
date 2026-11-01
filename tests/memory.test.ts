import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MemoryConflictError, MemoryStore } from "../src/memory";

const dbPath = join(process.cwd(), `jarvis-memory-tests-${randomUUID()}.sqlite`);
let store: MemoryStore;

before(async () => {
  store = await MemoryStore.open(dbPath);
});

after(() => {
  for (const path of [dbPath, `${dbPath}.lock`]) {
    if (existsSync(path)) unlinkSync(path);
  }
});

test("persists and retrieves user memory across store instances", async () => {
  const record = await store.create({
    kind: "fact",
    key: "preferred-name",
    value: "Sam",
    provenance: "User said so",
  });
  assert.ok(record.id);
  assert.equal(Number.isNaN(Date.parse(record.createdAt)), false);
  assert.equal(Number.isNaN(Date.parse(record.updatedAt)), false);
  assert.equal(record.provenance, "User said so");
  const reopened = await MemoryStore.open(dbPath);
  assert.deepEqual(await reopened.get("preferred-name"), record);
  assert.equal((await reopened.list("fact")).length, 1);

  const persistedJson = execFileSync(
    process.execPath,
    [
      "-e",
      "const { MemoryStore } = require('./dist/src/memory'); MemoryStore.open(process.argv[1]).then(async store => console.log(JSON.stringify(await store.get('preferred-name')))).catch(error => { console.error(error.message); process.exitCode = 1; });",
      dbPath,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(persistedJson), record);
});

test("corrections retain provenance and timestamped history", async () => {
  const old = await store.get("preferred-name");
  assert.ok(old);
  const corrected = await store.update("preferred-name", old.version, {
    kind: "fact",
    key: "preferred-name",
    value: "Samuel",
    provenance: "User corrected the preferred name",
  });

  assert.equal(corrected.version, old.version + 1);
  assert.equal(corrected.createdAt, old.createdAt);
  assert.ok(corrected.updatedAt >= old.updatedAt);
  assert.equal(corrected.provenance, "User corrected the preferred name");
  assert.deepEqual((await store.history("preferred-name")).map(({ value, provenance }) => [value, provenance]), [
    ["Sam", "User said so"],
    ["Samuel", "User corrected the preferred name"],
  ]);
});

test("rejects stale updates instead of silently overwriting newer memory", async () => {
  const stale = await store.get("preferred-name");
  assert.ok(stale);
  const otherStore = await MemoryStore.open(dbPath);
  await otherStore.update("preferred-name", stale.version, {
    kind: "fact",
    key: "preferred-name",
    value: "Sammy",
    provenance: "Second correction",
  });
  await assert.rejects(
    store.update("preferred-name", stale.version, {
      kind: "fact",
      key: "preferred-name",
      value: "S.",
      provenance: "Stale correction",
    }),
    (error: unknown) =>
      error instanceof MemoryConflictError && error.expectedVersion === stale.version && error.actualVersion === stale.version + 1,
  );
  assert.equal((await store.get("preferred-name"))?.value, "Sammy");
  assert.deepEqual(await store.search("Samuel"), []);
});

test("stores goals, projects, and decisions as distinct memory types", async () => {
  for (const kind of ["goal", "project", "decision"] as const) {
    await store.create({ kind, key: `sample-${kind}`, value: `A ${kind}`, provenance: "User request" });
  }
  assert.deepEqual(
    (await store.list()).map((memory) => memory.kind).sort(),
    ["decision", "fact", "goal", "project"],
  );
});

test("search returns only matching current memories in relevance order", async () => {
  await store.create({
    kind: "project",
    key: "jarvis-platform",
    value: "Build a personal assistant with durable memory",
    provenance: "User project",
  });
  const results = await store.search("personal assistant memory");
  assert.deepEqual(results.map(({ key }) => key), ["jarvis-platform"]);
  assert.equal((await store.search("no matching information")).length, 0);
  await assert.rejects(store.search("   "), /query must not be empty/);
});

test("matches Arabic, English, and mixed-language reply-preference questions narrowly", async () => {
  const preference = await store.create({
    kind: "fact",
    key: "preference:reply-language",
    value: "Arabic Levantine",
    provenance: "Explicitly provided by the user",
  });
  await store.create({
    kind: "fact",
    key: "preference:reply-style",
    value: "Concise",
    provenance: "Explicitly provided by the user",
  });
  await store.create({
    kind: "fact",
    key: "preference:language-learning",
    value: "Beginner",
    provenance: "Explicitly provided by the user",
  });
  await store.create({
    kind: "fact",
    key: "reply-language",
    value: "Arabic Levantine",
    provenance: "A separate fact, not a preference",
  });

  const arabicResults = await store.search("شو لغة الرد المفضلة عندي؟");
  assert.deepEqual(arabicResults.map(({ key }) => key), [preference.key]);

  const englishResults = await store.search("What is my preferred reply language?");
  assert.ok(englishResults.some(({ key }) => key === preference.key));
  assert.ok(englishResults.some(({ key }) => key === "reply-language"));
  assert.ok(englishResults.some(({ key }) => key === "preference:reply-style"));
  assert.ok(englishResults.some(({ key }) => key === "preference:language-learning"));

  const mixedResults = await store.search("شو response لغة مفضلة عندي؟");
  assert.deepEqual(mixedResults.map(({ key }) => key), [preference.key]);

  assert.deepEqual(await store.search("لغة الرد عندي؟"), []);
  assert.deepEqual(await store.search("اللغة المفضلة عندي؟"), []);
});

test("retrieves test colors across Arabic and English without matching partial concepts", async () => {
  const target = await store.create({
    kind: "fact",
    key: "test-favorite-color",
    value: "blue",
    provenance: "Explicitly provided by the user",
  });
  await store.create({
    kind: "fact",
    key: "favorite-color",
    value: "green",
    provenance: "A different color memory",
  });
  await store.create({
    kind: "fact",
    key: "test-result",
    value: "passed",
    provenance: "A different test memory",
  });

  for (const query of [
    "شو لون الاختبار اللي طلبت منك تتذكره؟",
    "شو ألوان الاختبار اللي طلبت منك تحفظها؟",
    "ما لون الاختبار الذي طلبت تذكره؟",
    "ما لون التجربة التي طلبت حفظه؟",
    "What color did I ask you to remember for the test?",
    "Which colour did I mention during testing?",
    "Which colour was my favourite during testing?",
  ]) {
    const results = await store.search(query);
    assert.ok(
      results.some(({ key }) => key === target.key),
      `expected ${query} to retrieve the test color`,
    );
    if (query.startsWith("شو") || query.startsWith("ما") || query.startsWith("Which colour")) {
      assert.deepEqual(results.map(({ key }) => key), [target.key]);
    }
  }

  const reopened = await MemoryStore.open(dbPath);
  assert.deepEqual(
    (await reopened.search("شو لون الاختبار اللي طلبت منك تتذكره؟")).map(({ key }) => key),
    [target.key],
  );
  assert.deepEqual(await store.search("شو لون الشيء المفضل عندي؟"), []);
  assert.deepEqual(await store.search("شو اسم المشروع الذي طلبت حفظه؟"), []);
  assert.deepEqual(await store.search("شو لون المسابقة المجهولة؟"), []);
});

test("keeps literal search scoring and ordering unchanged outside language-preference queries", async () => {
  const alpha = await store.create({
    kind: "fact",
    key: "legacy-ranking-alpha",
    value: "cerulean",
    provenance: "manual",
  });
  const beta = await store.create({
    kind: "fact",
    key: "legacy-ranking-beta",
    value: "cerulean",
    provenance: "manual",
  });

  assert.deepEqual(
    (await store.search("legacy ranking alpha cerulean")).map(({ key }) => key),
    [alpha.key, beta.key],
  );
  assert.deepEqual(await store.search("cerulean"), [alpha, beta]);
});

test("serializes concurrent writes and rejects duplicate keys", async () => {
  const results = await Promise.allSettled([
    store.create({ kind: "fact", key: "concurrent-key", value: "first", provenance: "test" }),
    store.create({ kind: "fact", key: "concurrent-key", value: "second", provenance: "test" }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof Error);
  assert.match(rejected.reason.message, /already exists/);
  assert.equal((await store.history("concurrent-key")).length, 1);
});

test("allows only one concurrent correction for a given version", async () => {
  const original = await store.create({
    kind: "fact",
    key: "concurrent-correction",
    value: "before",
    provenance: "initial",
  });
  const updates = await Promise.allSettled([
    store.update("concurrent-correction", original.version, {
      kind: "fact",
      key: "concurrent-correction",
      value: "correction A",
      provenance: "first writer",
    }),
    store.update("concurrent-correction", original.version, {
      kind: "fact",
      key: "concurrent-correction",
      value: "correction B",
      provenance: "second writer",
    }),
  ]);
  assert.equal(updates.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = updates.find(({ status }) => status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof MemoryConflictError);
  assert.equal((await store.history("concurrent-correction")).length, 2);
});
