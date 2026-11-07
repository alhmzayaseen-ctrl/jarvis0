import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import initSqlJs from "sql.js";
import { MemoryConflictError, MemoryStore, type TaskUpdateInput } from "../src/memory";

const dbPath = join(tmpdir(), `jarvis-memory-tests-${randomUUID()}.sqlite`);
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

test("creates the SQLite lock file with mode 0600", async () => {
  const lockDatabasePath = join(tmpdir(), `jarvis-lock-mode-${randomUUID()}.sqlite`);
  try {
    const lockStore = await MemoryStore.open(lockDatabasePath);
    const pendingWrite = lockStore.create({
      kind: "fact",
      key: "lock-mode",
      value: "temporary lock permission check",
      provenance: "lock permission test",
    });
    try {
      assert.equal(statSync(`${lockDatabasePath}.lock`).mode & 0o777, 0o600);
    } finally {
      await pendingWrite;
    }
  } finally {
    for (const path of [lockDatabasePath, `${lockDatabasePath}.lock`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
});

test("restricts Jarvis directory and SQLite file permissions, including existing paths", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "jarvis-permissions-"));
  const temporaryHome = join(temporaryRoot, "home");
  const jarvisDirectory = join(temporaryHome, ".jarvis");
  const databasePath = join(jarvisDirectory, "jarvis.sqlite");
  const originalHome = process.env.HOME;

  process.env.HOME = temporaryHome;
  try {
    const permissionStore = await MemoryStore.open(databasePath);
    assert.equal(statSync(jarvisDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);

    await permissionStore.create({
      kind: "fact",
      key: "permission-test",
      value: "temporary fixture",
      provenance: "permission test",
    });
    chmodSync(jarvisDirectory, 0o755);
    chmodSync(databasePath, 0o644);

    await MemoryStore.open(databasePath);
    assert.equal(statSync(jarvisDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects an intermediate Jarvis path symlink before creating external files", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "jarvis-symlink-check-"));
  const temporaryHome = join(temporaryRoot, "home");
  const jarvisDirectory = join(temporaryHome, ".jarvis");
  const externalDirectory = join(temporaryRoot, "external");
  const databasePath = join(jarvisDirectory, "linked", "jarvis.sqlite");
  const originalHome = process.env.HOME;

  mkdirSync(jarvisDirectory, { recursive: true });
  mkdirSync(externalDirectory);
  symlinkSync(externalDirectory, join(jarvisDirectory, "linked"), "dir");
  process.env.HOME = temporaryHome;
  try {
    await assert.rejects(
      MemoryStore.open(databasePath),
      /Jarvis database path must not contain symbolic links/,
    );
    assert.deepEqual(readdirSync(externalDirectory), []);
    assert.equal(existsSync(`${databasePath}.lock`), false);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
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

test("updates task details and changes status through an event", async () => {
  await withTemporaryTaskStore(async (taskStore, databasePath) => {
    const created = await taskStore.createTask({
      title: "Prepare release",
      description: "Review the release checklist",
      status: "pending",
    });

    assert.deepEqual(await taskStore.getTask(created.id), created);

    const updated = await taskStore.updateTask(created.id, {
      title: "Prepare final release",
      description: "Approved release checklist",
    });
    assert.equal(updated.status, "pending");
    assert.equal(updated.title, "Prepare final release");
    assert.equal(updated.description, "Approved release checklist");
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(updated.updatedAt >= created.updatedAt);

    const started = await taskStore.addTaskEvent({
      taskId: created.id,
      eventType: "status_changed",
      content: "Work started",
      status: "in_progress",
    });
    assert.deepEqual(await taskStore.listTaskEvents(created.id), [started]);
    assert.equal((await taskStore.getTask(created.id))?.status, "in_progress");

    const reopened = await MemoryStore.open(databasePath);
    assert.deepEqual(await reopened.getTask(created.id), {
      ...updated,
      status: "in_progress",
      updatedAt: started.createdAt,
    });
  });
});

test("rejects status in updateTask at runtime without changing task state", async () => {
  await withTemporaryTaskStore(async (taskStore) => {
    const task = await taskStore.createTask({ title: "Keep pending", status: "pending" });
    const attemptedStatusUpdate = { status: "completed" } as unknown as TaskUpdateInput;

    await assert.rejects(
      taskStore.updateTask(task.id, attemptedStatusUpdate),
      /Use addTaskEvent to change task status/,
    );

    assert.equal((await taskStore.getTask(task.id))?.status, "pending");
    assert.deepEqual(await taskStore.listTaskEvents(task.id), []);
  });
});

test("stores task events in insertion order and applies their status updates", async () => {
  await withTemporaryTaskStore(async (taskStore) => {
    const task = await taskStore.createTask({ title: "Track implementation", status: "pending" });
    const started = await taskStore.addTaskEvent({
      id: "event-started",
      taskId: task.id,
      eventType: "status_changed",
      content: "Work started",
      status: "in_progress",
    });
    const completed = await taskStore.addTaskEvent({
      id: "event-completed",
      taskId: task.id,
      eventType: "status_changed",
      content: "Work completed",
      status: "completed",
    });

    assert.deepEqual(await taskStore.listTaskEvents(task.id), [started, completed]);
    assert.equal((await taskStore.getTask(task.id))?.status, "completed");
  });
});

test("rejects a stale expected task status without changing state or adding an event", async () => {
  await withTemporaryTaskStore(async (taskStore) => {
    const task = await taskStore.createTask({ title: "Guard a stale transition", status: "pending" });
    const started = await taskStore.addTaskEvent({
      taskId: task.id,
      eventType: "status_changed",
      content: "Task started",
      status: "in_progress",
      expectedStatus: "pending",
    });

    await assert.rejects(
      taskStore.addTaskEvent({
        taskId: task.id,
        eventType: "status_changed",
        content: "Stale completion attempt",
        status: "completed",
        expectedStatus: "pending",
      }),
      /Task status changed: expected pending, found in_progress/,
    );

    assert.equal((await taskStore.getTask(task.id))?.status, "in_progress");
    assert.deepEqual(await taskStore.listTaskEvents(task.id), [started]);
  });
});

test("adds a stable sequence to an existing task_events table without losing events", async () => {
  const databasePath = join(tmpdir(), `jarvis-legacy-task-tests-${randomUUID()}.sqlite`);
  const SQL = await initSqlJs();
  const legacyDb = new SQL.Database();
  try {
    legacyDb.run("PRAGMA foreign_keys = ON");
    legacyDb.run(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        event_type TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('legacy-task', 'Legacy task', NULL, 'pending', 't0', 't0');
      INSERT INTO task_events VALUES ('legacy-event-a', 'legacy-task', 'note', 'first', 't1');
      INSERT INTO task_events VALUES ('legacy-event-b', 'legacy-task', 'note', 'second', 't2');
    `);
    writeFileSync(databasePath, Buffer.from(legacyDb.export()));
  } finally {
    legacyDb.close();
  }

  try {
    const migratedStore = await MemoryStore.open(databasePath);
    assert.deepEqual(
      (await migratedStore.listTaskEvents("legacy-task")).map(({ id }) => id),
      ["legacy-event-a", "legacy-event-b"],
    );

    const migratedDb = new SQL.Database(new Uint8Array(readFileSync(databasePath)));
    try {
      const rows = migratedDb.exec(
        "SELECT id, sequence FROM task_events ORDER BY sequence ASC",
      )[0]?.values;
      assert.deepEqual(rows, [
        ["legacy-event-a", 1],
        ["legacy-event-b", 2],
      ]);
    } finally {
      migratedDb.close();
    }
  } finally {
    for (const path of [databasePath, `${databasePath}.lock`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
});

test("SQLite itself rejects task events referencing a missing task", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        event_type TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL
      );
    `);

    assert.throws(
      () =>
        db.run(
          "INSERT INTO task_events (id, task_id, event_type, created_at) VALUES (?, ?, ?, ?)",
          ["orphan-event", "missing-task", "note", "t0"],
        ),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    db.close();
  }
});

test("serializes concurrent task and event writes across independent stores", async () => {
  await withTemporaryTaskStore(async (firstStore, databasePath) => {
    const secondStore = await MemoryStore.open(databasePath);
    const stores = [firstStore, secondStore];
    const tasks = await Promise.all([
      firstStore.createTask({ title: "Concurrent task one", status: "pending" }),
      secondStore.createTask({ title: "Concurrent task two", status: "pending" }),
    ]);
    const eventCount = 20;
    const expectedTaskByEvent = new Map<string, string>();

    await Promise.all(
      Array.from({ length: eventCount }, (_, index) => {
        const eventId = `concurrent-event-${index}`;
        const task = tasks[index % tasks.length];
        expectedTaskByEvent.set(eventId, task.id);
        return stores[index % stores.length].addTaskEvent({
          id: eventId,
          taskId: task.id,
          eventType: "concurrent-note",
          content: `event-${index}`,
        });
      }),
    );

    const SQL = await initSqlJs();
    const db = new SQL.Database(new Uint8Array(readFileSync(databasePath)));
    try {
      const storedTasks = db.exec("SELECT id FROM tasks ORDER BY id")[0]?.values ?? [];
      assert.deepEqual(new Set(storedTasks.map(([id]) => String(id))), new Set(tasks.map(({ id }) => id)));

      const storedEvents = db.exec(
        "SELECT sequence, id, task_id FROM task_events ORDER BY sequence ASC",
      )[0]?.values ?? [];
      assert.equal(storedEvents.length, eventCount);
      assert.deepEqual(
        storedEvents.map(([sequence]) => Number(sequence)),
        Array.from({ length: eventCount }, (_, index) => index + 1),
      );
      assert.equal(new Set(storedEvents.map(([, id]) => String(id))).size, eventCount);
      for (const [, id, taskId] of storedEvents) {
        assert.equal(expectedTaskByEvent.get(String(id)), String(taskId));
      }
      assert.deepEqual(db.exec("PRAGMA foreign_key_check"), []);

      for (const task of tasks) {
        const expectedIds = [...expectedTaskByEvent]
          .filter(([, taskId]) => taskId === task.id)
          .map(([id]) => id);
        const listedIds = (await firstStore.listTaskEvents(task.id)).map(({ id }) => id);
        assert.deepEqual(
          listedIds,
          storedEvents
            .filter(([, , taskId]) => String(taskId) === task.id)
            .map(([, id]) => String(id)),
        );
        assert.deepEqual(new Set(listedIds), new Set(expectedIds));
      }
    } finally {
      db.close();
    }
  });
});

test("does not persist a task status update when its event insert fails", async () => {
  await withTemporaryTaskStore(async (taskStore, databasePath) => {
    const task = await taskStore.createTask({ title: "Atomic event write", status: "pending" });
    await taskStore.addTaskEvent({
      id: "duplicate-event-id",
      taskId: task.id,
      eventType: "status_changed",
      status: "in_progress",
    });

    await assert.rejects(
      taskStore.addTaskEvent({
        id: "duplicate-event-id",
        taskId: task.id,
        eventType: "status_changed",
        status: "completed",
      }),
      /UNIQUE constraint failed/,
    );

    const reopened = await MemoryStore.open(databasePath);
    assert.equal((await reopened.getTask(task.id))?.status, "in_progress");
    assert.equal((await reopened.listTaskEvents(task.id)).length, 1);
  });
});

test("task storage does not change existing memory records or history", async () => {
  await withTemporaryTaskStore(async (taskStore) => {
    const memory = await taskStore.create({
      kind: "fact",
      key: "task-storage-regression",
      value: "preserved memory",
      provenance: "test fixture",
    });
    const task = await taskStore.createTask({ title: "Independent task", status: "pending" });
    await taskStore.addTaskEvent({ taskId: task.id, eventType: "note", content: "Task event" });

    assert.deepEqual(await taskStore.get(memory.key), memory);
    assert.deepEqual(await taskStore.history(memory.key), [{ ...memory, revision: 1 }]);
    assert.equal((await taskStore.list()).length, 1);
  });
});

async function withTemporaryTaskStore<T>(
  action: (store: MemoryStore, databasePath: string) => Promise<T>,
): Promise<T> {
  const databasePath = join(tmpdir(), `jarvis-task-tests-${randomUUID()}.sqlite`);
  try {
    const taskStore = await MemoryStore.open(databasePath);
    return await action(taskStore, databasePath);
  } finally {
    for (const path of [databasePath, `${databasePath}.lock`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
}
