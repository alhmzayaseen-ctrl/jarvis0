import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { MemoryStore, type MemoryRecord } from "../src/memory";

import fs = require("node:fs");

const IDX_PHASE = 0;
const IDX_A_ACTIVE = 1;

const PHASE_INIT = 0;
const PHASE_RELEASE_B = 1;
const PHASE_RELEASE_A = 2;
const PHASE_ABORT = 99;

const ATOMICS_TIMEOUT_MS = 5_000;

interface RaceWorkerData {
  role:
    | "A"
    | "B"
    | "A_FENCE"
    | "A_RELEASE_TOCTOU"
    | "A_RELEASE_HOLD_EVICT"
    | "EVICT_RELEASE_TOCTOU"
    | "EVICT_ACQUIRE_TOCTOU"
    | "STAGE_CREATOR_A"
    | "OBSERVER_WRITER";
  dbPath: string;
  syntheticDeadPid: number;
  sharedBuffer: SharedArrayBuffer;
}

type WorkerOutMessage =
  | { type: "OPENED" }
  | { type: "B_BEFORE_EVICT" }
  | { type: "B_EVICT_ABORTED" }
  | { type: "A_AT_RENAME"; tokenA: string }
  | { type: "A_BEFORE_FENCE"; tokenA: string; inoA: number }
  | { type: "A_RELEASE_AFTER_PRECHECK"; tokenA: string; inoA: number }
  | { type: "A_RELEASE_FINISHED_FIRST_ATTEMPT" }
  | { type: "A_RELEASE_AT_UNLINK_INSIDE_EVICT"; tokenA: string; inoA: number }
  | {
      type: "EVICT_RELEASE_AT_UNLINK";
      evictToken: string;
      evictEntryPath: string;
    }
  | { type: "EVICT_RELEASE_COMPLETED" }
  | { type: "EVICT_ACQUIRE_AT_UNLINK"; staleEntryPath: string }
  | { type: "EVICT_ACQUIRE_ABORTED" }
  | {
      type: "STAGE_CREATOR_A_PAUSED";
      stageDirPath: string;
      stageToken: string;
    }
  | { type: "OBSERVER_CHECKED_LOCK"; observedReads: number }
  | { type: "DONE"; record: MemoryRecord }
  | { type: "ERROR"; message: string };

type MainToWorkerMessage = { cmd: "START_CREATE" };

function waitForPhase(ctrl: Int32Array, expectedPhase: number): void {
  while (true) {
    const current = Atomics.load(ctrl, IDX_PHASE);
    if (current === expectedPhase) {
      return;
    }
    if (current === PHASE_ABORT) {
      throw new Error("Worker aborted via shared control buffer.");
    }
    const waitResult = Atomics.wait(ctrl, IDX_PHASE, current, ATOMICS_TIMEOUT_MS);
    if (waitResult === "timed-out") {
      throw new Error(
        `Timed out waiting for phase ${expectedPhase} (current=${Atomics.load(ctrl, IDX_PHASE)}).`,
      );
    }
  }
}

function seedEvictLockDir(
  evictDirPath: string,
  payload: { createdAt: number; pid: number; token: string },
): { entryPath: string; ino: number } {
  fs.mkdirSync(evictDirPath, { recursive: true, mode: 0o700 });
  const entryPath = join(evictDirPath, `${payload.token}.lock`);
  fs.writeFileSync(entryPath, JSON.stringify(payload), { mode: 0o600 });
  return { entryPath, ino: fs.lstatSync(entryPath).ino };
}

function cleanupEvictLockDir(evictDirPath: string): void {
  if (!fs.existsSync(evictDirPath)) {
    return;
  }
  const stat = fs.lstatSync(evictDirPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(evictDirPath)) {
      try {
        fs.unlinkSync(join(evictDirPath, entry));
      } catch {
        // Ignore cleanup error.
      }
    }
    try {
      fs.rmdirSync(evictDirPath);
    } catch {
      // Ignore cleanup error.
    }
  } else {
    try {
      fs.unlinkSync(evictDirPath);
    } catch {
      // Ignore cleanup error.
    }
  }
}

async function runRaceWorker(data: RaceWorkerData): Promise<void> {
  const port = parentPort;
  if (!port) {
    throw new Error("Worker must have a parentPort.");
  }

  const ctrl = new Int32Array(data.sharedBuffer);
  const lockPath = `${data.dbPath}.lock`;
  const evictLockPath = `${lockPath}.evict`;
  const realKill = process.kill.bind(process);
  const realUnlinkSync = fs.unlinkSync.bind(fs);
  const realChmodSync = fs.chmodSync.bind(fs);
  const realRenameSync = fs.renameSync.bind(fs);
  const realRmdirSync = fs.rmdirSync.bind(fs);
  const realMkdirSync = fs.mkdirSync.bind(fs);
  const realReadFileSync = fs.readFileSync.bind(fs);

  try {
    // Isolate process.kill(pid, 0) inside THIS exact Worker Thread that runs acquireLock() / isProcessAlive()
    mock.method(
      process,
      "kill",
      (pid: number, signal?: string | number): true => {
        if (pid === data.syntheticDeadPid && (signal === 0 || signal === undefined)) {
          const err = Object.assign(new Error("kill ESRCH"), {
            code: "ESRCH",
            errno: -3,
            syscall: "kill",
          });
          throw err;
        }
        return realKill(pid, signal as number);
      },
    );

    const store = await MemoryStore.open(data.dbPath);

    const startCommand = new Promise<void>((resolve) => {
      port.once("message", (msg: MainToWorkerMessage) => {
        if (msg?.cmd === "START_CREATE") {
          resolve();
        }
      });
    });

    port.postMessage({ type: "OPENED" } satisfies WorkerOutMessage);
    await startCommand;

    if (data.role === "B") {
      let dbCommitted = false;
      let interceptedEvictClaim = false;
      let notifiedEvictAborted = false;

      mock.method(
        fs,
        "renameSync",
        (oldPath: fs.PathLike, newPath: fs.PathLike): void => {
          if (String(newPath) === data.dbPath) {
            dbCommitted = true;
          }
          if (
            !dbCommitted &&
            !interceptedEvictClaim &&
            String(newPath) === evictLockPath &&
            fs.existsSync(lockPath)
          ) {
            interceptedEvictClaim = true;
            // Pause B right as it attempts to claim .evict inside tryEvictAndClaimStaleLock,
            // allowing A to evict stale-0 and acquire live lock tokenA first.
            port.postMessage({ type: "B_BEFORE_EVICT" } satisfies WorkerOutMessage);
            waitForPhase(ctrl, PHASE_RELEASE_B);
          }
          realRenameSync(oldPath, newPath);
        },
      );

      mock.method(
        fs,
        "rmdirSync",
        (targetPath: fs.PathLike, options?: fs.RmDirOptions): void => {
          realRmdirSync(targetPath, options);
          if (
            interceptedEvictClaim &&
            !notifiedEvictAborted &&
            String(targetPath) === evictLockPath
          ) {
            notifiedEvictAborted = true;
            // Deterministic signal: B finished tryEvictAndClaimStaleLock's finally block
            port.postMessage({ type: "B_EVICT_ABORTED" } satisfies WorkerOutMessage);
          }
        },
      );

      const record = await store.create({
        kind: "fact",
        key: "record-b",
        value: "Committed by Writer B",
        provenance: "worker-b",
      });
      port.postMessage({ type: "DONE", record } satisfies WorkerOutMessage);
    } else if (data.role === "A") {
      let interceptedRename = false;
      mock.method(
        fs,
        "renameSync",
        (oldPath: fs.PathLike, newPath: fs.PathLike): void => {
          if (!interceptedRename && String(newPath) === data.dbPath) {
            interceptedRename = true;
            const currentLock = JSON.parse(
              realReadFileSync(lockPath, "utf8") as string,
            ) as { token: string };
            Atomics.store(ctrl, IDX_A_ACTIVE, 1);
            port.postMessage({
              type: "A_AT_RENAME",
              tokenA: currentLock.token,
            } satisfies WorkerOutMessage);
            try {
              waitForPhase(ctrl, PHASE_RELEASE_A);
            } catch (error) {
              Atomics.store(ctrl, IDX_A_ACTIVE, 0);
              throw error;
            }
            realRenameSync(oldPath, newPath);
            Atomics.store(ctrl, IDX_A_ACTIVE, 0);
            return;
          }
          realRenameSync(oldPath, newPath);
        },
      );

      const record = await store.create({
        kind: "fact",
        key: "record-a",
        value: "Written by Writer A",
        provenance: "worker-a",
      });
      port.postMessage({ type: "DONE", record } satisfies WorkerOutMessage);
    } else if (data.role === "A_FENCE") {
      let interceptedPendingChmod = false;

      mock.method(
        fs,
        "chmodSync",
        (targetPath: fs.PathLike, mode: fs.Mode): void => {
          realChmodSync(targetPath, mode);
          if (!interceptedPendingChmod && String(targetPath).endsWith(".pending")) {
            interceptedPendingChmod = true;
            const statA = fs.lstatSync(lockPath);
            const currentLock = JSON.parse(
              realReadFileSync(lockPath, "utf8") as string,
            ) as { token: string };
            Atomics.store(ctrl, IDX_A_ACTIVE, 1);
            port.postMessage({
              type: "A_BEFORE_FENCE",
              tokenA: currentLock.token,
              inoA: statA.ino,
            } satisfies WorkerOutMessage);
            try {
              waitForPhase(ctrl, PHASE_RELEASE_A);
            } finally {
              Atomics.store(ctrl, IDX_A_ACTIVE, 0);
            }
          }
        },
      );

      const record = await store.create({
        kind: "fact",
        key: "record-a",
        value: "Written after write-fence retry by Writer A",
        provenance: "worker-a",
      });
      port.postMessage({ type: "DONE", record } satisfies WorkerOutMessage);
    } else if (data.role === "A_RELEASE_TOCTOU") {
      // Pauses inside releaseMainLockIfOwned AFTER preCheck = inspectLockFile(lockPath)
      // has verified lockA, and BEFORE acquireEvictLock + unlinkSync(lockPath) executes.
      let dbCommittedOnFirstAttempt = false;
      let pausedAfterPreCheck = false;
      let notifiedReleaseFinished = false;

      mock.method(
        fs,
        "renameSync",
        (oldPath: fs.PathLike, newPath: fs.PathLike): void => {
          realRenameSync(oldPath, newPath);
          if (!dbCommittedOnFirstAttempt && String(newPath) === data.dbPath) {
            dbCommittedOnFirstAttempt = true;
          }
        },
      );

      mock.method(
        fs,
        "mkdirSync",
        (targetPath: fs.PathLike, options?: fs.MakeDirectoryOptions | fs.Mode | null) => {
          if (
            dbCommittedOnFirstAttempt &&
            !pausedAfterPreCheck &&
            String(targetPath).startsWith(`${evictLockPath}.`) &&
            String(targetPath).endsWith(".stage")
          ) {
            pausedAfterPreCheck = true;
            const statA = fs.lstatSync(lockPath);
            const currentLock = JSON.parse(
              realReadFileSync(lockPath, "utf8") as string,
            ) as { token: string };
            port.postMessage({
              type: "A_RELEASE_AFTER_PRECHECK",
              tokenA: currentLock.token,
              inoA: statA.ino,
            } satisfies WorkerOutMessage);
            waitForPhase(ctrl, PHASE_RELEASE_A);
          }
          return realMkdirSync(targetPath, options as never);
        },
      );

      mock.method(
        fs,
        "rmdirSync",
        (targetPath: fs.PathLike, options?: fs.RmDirOptions): void => {
          realRmdirSync(targetPath, options);
          if (
            pausedAfterPreCheck &&
            !notifiedReleaseFinished &&
            String(targetPath) === evictLockPath
          ) {
            notifiedReleaseFinished = true;
            port.postMessage({
              type: "A_RELEASE_FINISHED_FIRST_ATTEMPT",
            } satisfies WorkerOutMessage);
          }
        },
      );

      const record = await store.create({
        kind: "fact",
        key: "record-a-release-toctou",
        value: "Written by A before releaseMainLockIfOwned race",
        provenance: "worker-a-release-toctou",
      });
      port.postMessage({ type: "DONE", record } satisfies WorkerOutMessage);
    } else if (data.role === "A_RELEASE_HOLD_EVICT") {
      // Pauses inside releaseMainLockIfOwned while holding .evict,
      // AFTER current = inspectLockFile(lockPath) has verified lockA,
      // right on the unlinkSync(lockPath) call itself!
      let pausedAtMainUnlink = false;

      mock.method(
        fs,
        "unlinkSync",
        (targetPath: fs.PathLike): void => {
          if (!pausedAtMainUnlink && String(targetPath) === lockPath) {
            pausedAtMainUnlink = true;
            const statA = fs.lstatSync(lockPath);
            const currentLock = JSON.parse(
              realReadFileSync(lockPath, "utf8") as string,
            ) as { token: string };
            port.postMessage({
              type: "A_RELEASE_AT_UNLINK_INSIDE_EVICT",
              tokenA: currentLock.token,
              inoA: statA.ino,
            } satisfies WorkerOutMessage);
            waitForPhase(ctrl, PHASE_RELEASE_A);
          }
          realUnlinkSync(targetPath);
        },
      );

      const record = await store.create({
        kind: "fact",
        key: "record-a-hold-evict",
        value: "Written by A holding .evict during release",
        provenance: "worker-a-hold-evict",
      });
      port.postMessage({ type: "DONE", record } satisfies WorkerOutMessage);
    } else if (data.role === "EVICT_RELEASE_TOCTOU") {
      // Pauses inside releaseEvictLock (in tryEvictAndClaimStaleLock's finally)
      // AFTER inspectLockFile(evictLock.entryPath) has passed verification,
      // right at the unlinkSync(evictLock.entryPath) syscall before rmdirSync(evictLockPath)!
      let pausedAtEvictUnlink = false;
      let notifiedEvictReleaseCompleted = false;

      mock.method(
        fs,
        "unlinkSync",
        (targetPath: fs.PathLike): void => {
          const target = String(targetPath);
          if (
            !pausedAtEvictUnlink &&
            target.startsWith(`${evictLockPath}/`) &&
            target.endsWith(".lock")
          ) {
            pausedAtEvictUnlink = true;
            const evictOwner = JSON.parse(
              realReadFileSync(target, "utf8") as string,
            ) as { token: string };
            port.postMessage({
              type: "EVICT_RELEASE_AT_UNLINK",
              evictToken: evictOwner.token,
              evictEntryPath: target,
            } satisfies WorkerOutMessage);
            waitForPhase(ctrl, PHASE_RELEASE_A);
          }
          realUnlinkSync(targetPath);
        },
      );

      mock.method(
        fs,
        "rmdirSync",
        (targetPath: fs.PathLike, options?: fs.RmDirOptions): void => {
          try {
            realRmdirSync(targetPath, options);
          } finally {
            if (
              pausedAtEvictUnlink &&
              !notifiedEvictReleaseCompleted &&
              String(targetPath) === evictLockPath
            ) {
              notifiedEvictReleaseCompleted = true;
              port.postMessage({
                type: "EVICT_RELEASE_COMPLETED",
              } satisfies WorkerOutMessage);
              waitForPhase(ctrl, PHASE_RELEASE_B);
            }
          }
        },
      );

      const record = await store.create({
        kind: "fact",
        key: "record-evict-replaced",
        value: "Committed after evict replacement check",
        provenance: "worker-evict",
      });
      port.postMessage({ type: "DONE", record } satisfies WorkerOutMessage);
    } else if (data.role === "EVICT_ACQUIRE_TOCTOU") {
      // Pauses inside acquireEvictLock AFTER inspectLockFile(staleEntryPath) has verified
      // the stale candidate, right at the unlinkSync(staleEntryPath) syscall!
      let pausedAtStaleEvictUnlink = false;
      let notifiedAcquireAborted = false;

      mock.method(
        fs,
        "unlinkSync",
        (targetPath: fs.PathLike): void => {
          const target = String(targetPath);
          if (
            !pausedAtStaleEvictUnlink &&
            target === join(evictLockPath, "stale-evict-0.lock")
          ) {
            pausedAtStaleEvictUnlink = true;
            port.postMessage({
              type: "EVICT_ACQUIRE_AT_UNLINK",
              staleEntryPath: target,
            } satisfies WorkerOutMessage);
            waitForPhase(ctrl, PHASE_RELEASE_B);
          }
          realUnlinkSync(targetPath);
        },
      );

      mock.method(
        fs,
        "rmdirSync",
        (targetPath: fs.PathLike, options?: fs.RmDirOptions): void => {
          realRmdirSync(targetPath, options);
          const target = String(targetPath);
          if (
            pausedAtStaleEvictUnlink &&
            !notifiedAcquireAborted &&
            target.startsWith(`${evictLockPath}.`) &&
            target.endsWith(".stage")
          ) {
            notifiedAcquireAborted = true;
            port.postMessage({
              type: "EVICT_ACQUIRE_ABORTED",
            } satisfies WorkerOutMessage);
          }
        },
      );

      const record = await store.create({
        kind: "fact",
        key: "record-evict-acquire-toctou",
        value: "Committed after losing evict race cleanly",
        provenance: "worker-evict-acquire-toctou",
      });
      port.postMessage({ type: "DONE", record } satisfies WorkerOutMessage);
    } else if (data.role === "STAGE_CREATOR_A") {
      // Creator A writes its stage ownership marker and pauses immediately before renameSync(stageDirPath, evictDirPath)
      let pausedBeforeRename = false;

      mock.method(
        fs,
        "renameSync",
        (oldPath: fs.PathLike, newPath: fs.PathLike): void => {
          const oldStr = String(oldPath);
          const newStr = String(newPath);
          if (
            !pausedBeforeRename &&
            oldStr.startsWith(`${evictLockPath}.`) &&
            oldStr.endsWith(".stage") &&
            newStr === evictLockPath
          ) {
            pausedBeforeRename = true;
            const entries = fs.readdirSync(oldStr);
            const tokenFile = entries.find((e) => e.endsWith(".lock")) ?? "";
            const token = tokenFile.replace(/\.lock$/, "");
            port.postMessage({
              type: "STAGE_CREATOR_A_PAUSED",
              stageDirPath: oldStr,
              stageToken: token,
            } satisfies WorkerOutMessage);
            waitForPhase(ctrl, PHASE_RELEASE_A);
          }
          realRenameSync(oldPath, newPath);
        },
      );

      const record = await store.create({
        kind: "fact",
        key: "record-stage-creator-a",
        value: "Committed by Stage Creator A",
        provenance: "worker-stage-creator-a",
      });
      port.postMessage({ type: "DONE", record } satisfies WorkerOutMessage);
    } else if (data.role === "OBSERVER_WRITER") {
      let observedReads = 0;
      let notifiedObserver = false;

      mock.method(
        fs,
        "readFileSync",
        (pathOrFd: fs.PathOrFileDescriptor, options?: unknown): string | Buffer => {
          const res = realReadFileSync(pathOrFd, options as never);
          const target = String(pathOrFd);
          if (target === lockPath || target.startsWith(`${evictLockPath}/`)) {
            observedReads += 1;
            if (!notifiedObserver && observedReads >= 2) {
              notifiedObserver = true;
              queueMicrotask(() => {
                port.postMessage({
                  type: "OBSERVER_CHECKED_LOCK",
                  observedReads,
                } satisfies WorkerOutMessage);
              });
            }
          }
          return res;
        },
      );

      const record = await store.create({
        kind: "fact",
        key: "record-observer",
        value: "Committed after valid lock release",
        provenance: "worker-observer",
      });
      port.postMessage({ type: "DONE", record } satisfies WorkerOutMessage);
    }
  } catch (error) {
    port.postMessage({
      type: "ERROR",
      message: error instanceof Error ? error.message : String(error),
    } satisfies WorkerOutMessage);
  } finally {
    // Explicitly restore all mocks inside THIS Worker Thread's own finally block.
    mock.restoreAll();
  }
}

if (!isMainThread) {
  void runRaceWorker(workerData as RaceWorkerData);
} else {
  function waitForWorkerMessage<T extends WorkerOutMessage["type"]>(
    worker: Worker,
    expectedType: T,
  ): Promise<Extract<WorkerOutMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const onMessage = (msg: WorkerOutMessage): void => {
        if (msg.type === "ERROR") {
          cleanupListeners();
          reject(new Error(`Worker error: ${msg.message}`));
          return;
        }
        if (msg.type === expectedType) {
          cleanupListeners();
          resolve(msg as Extract<WorkerOutMessage, { type: T }>);
        }
      };
      const onError = (err: Error): void => {
        cleanupListeners();
        reject(err);
      };
      const onExit = (code: number): void => {
        cleanupListeners();
        reject(
          new Error(
            `Worker exited prematurely with code ${code} while waiting for ${expectedType}.`,
          ),
        );
      };
      const cleanupListeners = (): void => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };

      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
    });
  }

  test("M-2 (1): two independent workers competing to evict a stale lock preserve live lock A and never overlap", async () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), "jarvis-m2-race-1-"));
    const dbPath = join(tempDir, "race-1.sqlite");
    const lockPath = `${dbPath}.lock`;
    const syntheticDeadPid = process.pid === 424_242 ? 424_243 : 424_242;
    const sharedBuffer = new SharedArrayBuffer(4 * 4);
    const ctrl = new Int32Array(sharedBuffer);
    Atomics.store(ctrl, IDX_PHASE, PHASE_INIT);
    Atomics.store(ctrl, IDX_A_ACTIVE, 0);

    let workerA: Worker | undefined;
    let workerB: Worker | undefined;

    try {
      const storeC = await MemoryStore.open(dbPath);

      workerA = new Worker(__filename, {
        workerData: {
          role: "A",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      workerB = new Worker(__filename, {
        workerData: {
          role: "B",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });

      await Promise.all([
        waitForWorkerMessage(workerA, "OPENED"),
        waitForWorkerMessage(workerB, "OPENED"),
      ]);

      // Seed expired stale lock with deterministic syntheticDeadPid (isolated via ESRCH inside workers)
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          createdAt: 0,
          pid: syntheticDeadPid,
          token: "stale-0",
        }),
        { mode: 0o600 },
      );

      // 1. Start B -> B detects stale-0 and pauses deterministically right before claiming .evict
      const bBeforeEvictPromise = waitForWorkerMessage(workerB, "B_BEFORE_EVICT");
      workerB.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      await bBeforeEvictPromise;

      // 2. Start A -> A acquires .evict, atomically replaces stale-0 with live lock tokenA, releases .evict, and pauses at renameSync
      const aAtRenamePromise = waitForWorkerMessage(workerA, "A_AT_RENAME");
      workerA.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      const { tokenA } = await aAtRenamePromise;
      assert.notEqual(tokenA, "stale-0");
      assert.equal(Atomics.load(ctrl, IDX_A_ACTIVE), 1);

      // 3. Release B -> B acquires .evict, re-inspects lockPath, sees inode & token changed to tokenA,
      //    aborts eviction without unlinking tokenA, releases .evict, and signals B_EVICT_ABORTED deterministically!
      const bEvictAbortedPromise = waitForWorkerMessage(workerB, "B_EVICT_ABORTED");
      const bDonePromise = waitForWorkerMessage(workerB, "DONE");
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_B);
      Atomics.notify(ctrl, IDX_PHASE);
      await bEvictAbortedPromise;

      // Verify A's live lock is STILL intact on disk after B completed tryEvictAndClaimStaleLock
      assert.equal(fs.existsSync(lockPath), true, "A's live lock must NOT be unlinked by B");
      const lockOwnerWhileAActive = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
        token: string;
      };
      assert.equal(lockOwnerWhileAActive.token, tokenA);
      assert.equal(Atomics.load(ctrl, IDX_A_ACTIVE), 1);

      // 4. Start C while A is still active, and track whether C ever overlaps with A
      const realMainRenameSync = fs.renameSync.bind(fs);
      let overlapDetected = false;

      mock.method(
        fs,
        "renameSync",
        (oldPath: fs.PathLike, newPath: fs.PathLike): void => {
          if (String(newPath) === dbPath && Atomics.load(ctrl, IDX_A_ACTIVE) === 1) {
            overlapDetected = true;
          }
          realMainRenameSync(oldPath, newPath);
        },
      );

      const cCreatePromise = storeC.create({
        kind: "fact",
        key: "record-c",
        value: "Committed by Writer C after A",
        provenance: "main-c",
      });

      // 5. Release A so A commits first, then B and C acquire locks in serialized order
      const aDonePromise = waitForWorkerMessage(workerA, "DONE");
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_A);
      Atomics.notify(ctrl, IDX_PHASE);

      const [aDone, bDone, recordC] = await Promise.all([
        aDonePromise,
        bDonePromise,
        cCreatePromise,
      ]);
      mock.restoreAll();

      assert.equal(
        overlapDetected,
        false,
        "Writer C must never overlap with Writer A inside withDatabase(true).",
      );
      assert.equal(aDone.record.key, "record-a");
      assert.equal(bDone.record.key, "record-b");
      assert.equal(recordC.key, "record-c");

      const inspector = await MemoryStore.openReadOnly(dbPath);
      assert.notEqual(await inspector.get("record-a"), null);
      assert.notEqual(await inspector.get("record-b"), null);
      assert.notEqual(await inspector.get("record-c"), null);

      const leftovers = fs
        .readdirSync(tempDir)
        .filter(
          (name) =>
            name.endsWith(".lock") ||
            name.endsWith(".evict") ||
            name.endsWith(".stage") ||
            name.endsWith(".pending"),
        );
      assert.deepEqual(leftovers, []);
    } finally {
      mock.restoreAll();
      Atomics.store(ctrl, IDX_PHASE, PHASE_ABORT);
      Atomics.notify(ctrl, IDX_PHASE);
      await Promise.allSettled([
        workerA?.terminate() ?? Promise.resolve(0),
        workerB?.terminate() ?? Promise.resolve(0),
      ]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("M-2 (2): never evicts a live process lock (.lock or .evict) based on expired age alone", async () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), "jarvis-m2-race-2-"));
    const dbPath = join(tempDir, "race-2.sqlite");
    const lockPath = `${dbPath}.lock`;
    const syntheticDeadPid = process.pid === 424_242 ? 424_243 : 424_242;
    const sharedBuffer = new SharedArrayBuffer(4 * 4);

    let worker1: Worker | undefined;
    let worker2: Worker | undefined;

    try {
      await MemoryStore.open(dbPath);

      // Part A: .lock has createdAt = 0 (age > LOCK_STALE_MS), but pid = process.pid (alive!)
      worker1 = new Worker(__filename, {
        workerData: {
          role: "OBSERVER_WRITER",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      await waitForWorkerMessage(worker1, "OPENED");

      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          createdAt: 0,
          pid: process.pid,
          token: "live-aged-main-lock",
        }),
        { mode: 0o600 },
      );
      const initialMainLockIno = fs.lstatSync(lockPath).ino;

      const checkedPromise1 = waitForWorkerMessage(worker1, "OBSERVER_CHECKED_LOCK");
      const donePromise1 = waitForWorkerMessage(worker1, "DONE");
      worker1.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      await checkedPromise1;

      // Verify worker1 inspected lockPath and did NOT evict it despite createdAt: 0
      assert.equal(fs.existsSync(lockPath), true);
      assert.equal(fs.lstatSync(lockPath).ino, initialMainLockIno);
      assert.equal(
        (JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token: string }).token,
        "live-aged-main-lock",
      );

      // Now live owner releases lockPath -> worker1 acquires and completes
      fs.unlinkSync(lockPath);
      const done1 = await donePromise1;
      assert.equal(done1.record.key, "record-observer");
      await worker1.terminate();
      worker1 = undefined;

      // Part B: .lock is stale & dead, AND .evict has createdAt = 0 (age > LOCK_STALE_MS) but pid = process.pid (alive!)
      const dbPath2 = join(tempDir, "race-2b.sqlite");
      const lockPath2 = `${dbPath2}.lock`;
      const evictLockPath2 = `${lockPath2}.evict`;
      await MemoryStore.open(dbPath2);

      worker2 = new Worker(__filename, {
        workerData: {
          role: "OBSERVER_WRITER",
          dbPath: dbPath2,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      await waitForWorkerMessage(worker2, "OPENED");

      fs.writeFileSync(
        lockPath2,
        JSON.stringify({
          createdAt: 0,
          pid: syntheticDeadPid,
          token: "dead-stale-main",
        }),
        { mode: 0o600 },
      );
      const { entryPath: liveEvictEntryPath, ino: initialEvictIno } = seedEvictLockDir(
        evictLockPath2,
        {
          createdAt: 0,
          pid: process.pid,
          token: "live-aged-evict-lock",
        },
      );

      const checkedPromise2 = waitForWorkerMessage(worker2, "OBSERVER_CHECKED_LOCK");
      const donePromise2 = waitForWorkerMessage(worker2, "DONE");
      worker2.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      await checkedPromise2;

      // Verify worker2 did NOT unlink live-aged-evict-lock despite createdAt: 0
      assert.equal(fs.existsSync(evictLockPath2), true);
      assert.equal(fs.existsSync(liveEvictEntryPath), true);
      assert.equal(fs.lstatSync(liveEvictEntryPath).ino, initialEvictIno);
      assert.equal(
        (JSON.parse(fs.readFileSync(liveEvictEntryPath, "utf8")) as { token: string }).token,
        "live-aged-evict-lock",
      );

      // Now live owner releases evictLockPath2 -> worker2 acquires .evict, evicts dead-stale-main, and commits
      cleanupEvictLockDir(evictLockPath2);
      const done2 = await donePromise2;
      assert.equal(done2.record.key, "record-observer");
    } finally {
      await Promise.allSettled([
        worker1?.terminate() ?? Promise.resolve(0),
        worker2?.terminate() ?? Promise.resolve(0),
      ]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("M-2 (3): old lock owner never deletes a replacement lock in finally even when replaced in the window between verification and deletion", async () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), "jarvis-m2-race-3-"));
    const dbPath = join(tempDir, "race-3.sqlite");
    const lockPath = `${dbPath}.lock`;
    const evictLockPath = `${lockPath}.evict`;
    const syntheticDeadPid = process.pid === 424_242 ? 424_243 : 424_242;
    const sharedBuffer = new SharedArrayBuffer(4 * 4);
    const ctrl = new Int32Array(sharedBuffer);

    let workerA: Worker | undefined;
    let workerEvict: Worker | undefined;

    try {
      await MemoryStore.open(dbPath);

      // Part A: Worker A enters finally -> releaseMainLockIfOwned, runs preCheck = inspectLockFile(lockPath)
      //         (verification succeeds!), and pauses right BEFORE acquiring .evict and calling unlinkSync(lockPath).
      //         During that exact verification-to-deletion window, lockPath is replaced by a new live lock!
      Atomics.store(ctrl, IDX_PHASE, PHASE_INIT);
      workerA = new Worker(__filename, {
        workerData: {
          role: "A_RELEASE_TOCTOU",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      await waitForWorkerMessage(workerA, "OPENED");

      const afterPreCheckPromise = waitForWorkerMessage(
        workerA,
        "A_RELEASE_AFTER_PRECHECK",
      );
      workerA.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      const { tokenA, inoA } = await afterPreCheckPromise;

      // Replace lockPath with a brand-new live lock AFTER Worker A's preCheck verification has already succeeded!
      fs.unlinkSync(lockPath);
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          createdAt: Date.now(),
          pid: process.pid,
          token: "new-replacement-lock",
        }),
        { mode: 0o600 },
      );
      const replacementIno = fs.lstatSync(lockPath).ino;
      assert.notEqual(replacementIno, inoA);
      assert.notEqual("new-replacement-lock", tokenA);

      // Resume A -> it acquires .evict, re-inspects lockPath under .evict, sees the replacement lock,
      // and aborts without calling unlinkSync(lockPath)!
      const releaseFinishedPromise = waitForWorkerMessage(
        workerA,
        "A_RELEASE_FINISHED_FIRST_ATTEMPT",
      );
      const aDonePromise = waitForWorkerMessage(workerA, "DONE");
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_A);
      Atomics.notify(ctrl, IDX_PHASE);
      await releaseFinishedPromise;

      // Verify A's releaseMainLockIfOwned did NOT delete new-replacement-lock!
      assert.equal(
        fs.existsSync(lockPath),
        true,
        "Old lock owner must not delete replacement .lock in the verification-to-deletion window",
      );
      assert.equal(fs.lstatSync(lockPath).ino, replacementIno);
      assert.equal(
        (JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token: string }).token,
        "new-replacement-lock",
      );

      const aDone = await aDonePromise;
      assert.equal(aDone.record.key, "record-a-release-toctou");
      fs.unlinkSync(lockPath);
      await workerA.terminate();
      workerA = undefined;

      // Part B: WorkerEvict enters tryEvictAndClaimStaleLock's finally -> releaseEvictLock,
      //         completes 100% of inspectLockFile(evictLock.entryPath) verification,
      //         and pauses at the exact unlinkSync(evictLock.entryPath) syscall before rmdirSync(evictLockPath)!
      Atomics.store(ctrl, IDX_PHASE, PHASE_INIT);
      workerEvict = new Worker(__filename, {
        workerData: {
          role: "EVICT_RELEASE_TOCTOU",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      await waitForWorkerMessage(workerEvict, "OPENED");

      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          createdAt: 0,
          pid: syntheticDeadPid,
          token: "stale-for-evict-test",
        }),
        { mode: 0o600 },
      );

      const evictAtUnlinkPromise = waitForWorkerMessage(
        workerEvict,
        "EVICT_RELEASE_AT_UNLINK",
      );
      const evictReleaseCompletedPromise = waitForWorkerMessage(
        workerEvict,
        "EVICT_RELEASE_COMPLETED",
      );
      const evictWorkerDonePromise = waitForWorkerMessage(workerEvict, "DONE");
      workerEvict.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      const { evictToken, evictEntryPath } = await evictAtUnlinkPromise;

      // Replace .evict on disk with a new live .evict entry AFTER inspectLockFile verification
      // and right BEFORE workerEvict executes unlinkSync(evictEntryPath) + rmdirSync(evictLockPath)!
      fs.unlinkSync(evictEntryPath);
      const { entryPath: replacementEvictEntry, ino: replacementEvictIno } =
        seedEvictLockDir(evictLockPath, {
          createdAt: Date.now(),
          pid: process.pid,
          token: "replacement-live-evict",
        });
      assert.notEqual(evictToken, "replacement-live-evict");

      // Resume workerEvict to execute unlinkSync(evictEntryPath) and rmdirSync(evictLockPath)
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_A);
      Atomics.notify(ctrl, IDX_PHASE);
      await evictReleaseCompletedPromise;

      // Verify the OS kernel (ENOENT on old token + ENOTEMPTY on rmdirSync) preserved replacement-live-evict 100% intact!
      assert.equal(
        fs.existsSync(evictLockPath),
        true,
        "Old .evict owner must not remove .evict directory when a replacement entry exists",
      );
      assert.equal(
        fs.existsSync(replacementEvictEntry),
        true,
        "Old .evict owner must not delete replacement .evict token file",
      );
      assert.equal(fs.lstatSync(replacementEvictEntry).ino, replacementEvictIno);
      assert.equal(
        (JSON.parse(fs.readFileSync(replacementEvictEntry, "utf8")) as { token: string })
          .token,
        "replacement-live-evict",
      );

      // Clean up the synthetic replacement .evict so workerEvict can finish releasing its main lock in withDatabase's finally
      cleanupEvictLockDir(evictLockPath);
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_B);
      Atomics.notify(ctrl, IDX_PHASE);
      const evictDone = await evictWorkerDonePromise;
      assert.equal(evictDone.record.key, "record-evict-replaced");
    } finally {
      Atomics.store(ctrl, IDX_PHASE, PHASE_ABORT);
      Atomics.notify(ctrl, IDX_PHASE);
      await Promise.allSettled([
        workerA?.terminate() ?? Promise.resolve(0),
        workerEvict?.terminate() ?? Promise.resolve(0),
      ]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("M-2 (4): recovers both stale .lock and stale .evict when owner process is dead (ESRCH) and age > LOCK_STALE_MS", async () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), "jarvis-m2-race-4-"));
    const dbPath = join(tempDir, "race-4.sqlite");
    const lockPath = `${dbPath}.lock`;
    const evictLockPath = `${lockPath}.evict`;
    const syntheticDeadPid = process.pid === 424_242 ? 424_243 : 424_242;
    const sharedBuffer = new SharedArrayBuffer(4 * 4);

    let worker: Worker | undefined;
    try {
      await MemoryStore.open(dbPath);

      worker = new Worker(__filename, {
        workerData: {
          role: "OBSERVER_WRITER",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      await waitForWorkerMessage(worker, "OPENED");

      // Seed both a dead stale .lock and a dead stale .evict directory entry
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          createdAt: 0,
          pid: syntheticDeadPid,
          token: "dead-process-lock",
        }),
        { mode: 0o600 },
      );
      seedEvictLockDir(evictLockPath, {
        createdAt: 0,
        pid: syntheticDeadPid,
        token: "dead-process-evict",
      });

      const donePromise = waitForWorkerMessage(worker, "DONE");
      worker.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      const done = await donePromise;
      assert.equal(done.record.key, "record-observer");

      const roStore = await MemoryStore.openReadOnly(dbPath);
      assert.notEqual(await roStore.get("record-observer"), null);
      assert.equal(fs.existsSync(lockPath), false);
      assert.equal(fs.existsSync(evictLockPath), false);
    } finally {
      await worker?.terminate();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("M-2 (5): cleans up .stage and fd on success/failure and evicts abandoned incomplete locks even with current or future mtimeMs", async () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), "jarvis-m2-race-5-"));
    const dbPath = join(tempDir, "race-5.sqlite");
    const lockPath = `${dbPath}.lock`;
    const syntheticDeadPid = process.pid === 424_242 ? 424_243 : 424_242;
    const sharedBuffer = new SharedArrayBuffer(4 * 4);
    const ctrl = new Int32Array(sharedBuffer);

    let workerFreshIncomplete: Worker | undefined;
    let workerTransitioned: Worker | undefined;

    try {
      const store = await MemoryStore.open(dbPath);

      // Part A: Verify tryCreateLockFile populates the staging file, closes its fd BEFORE linking it to lockPath,
      //         and cleans up .stage and fd on BOTH success and failure!
      const realOpenSync = fs.openSync.bind(fs);
      const realCloseSync = fs.closeSync.bind(fs);
      const realLinkSync = fs.linkSync.bind(fs);
      const openedStageFds = new Set<number>();
      let verifiedPreLinkPayloadAndClosedFd = false;

      mock.method(
        fs,
        "openSync",
        (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null): number => {
          const fd = realOpenSync(path, flags, mode);
          if (String(path).endsWith(".stage")) {
            openedStageFds.add(fd);
          }
          return fd;
        },
      );

      mock.method(fs, "closeSync", (fd: number): void => {
        openedStageFds.delete(fd);
        realCloseSync(fd);
      });

      mock.method(
        fs,
        "linkSync",
        (existingPath: fs.PathLike, newPath: fs.PathLike): void => {
          if (String(newPath) === lockPath) {
            assert.equal(fs.existsSync(lockPath), false);
            assert.equal(
              openedStageFds.size,
              0,
              "Stage file descriptor must already be closed before linkSync",
            );
            const stageRaw = fs.readFileSync(existingPath, "utf8");
            const stageParsed = JSON.parse(stageRaw) as {
              createdAt: number;
              pid: number;
              token: string;
            };
            assert.equal(typeof stageParsed.createdAt, "number");
            assert.equal(stageParsed.pid, process.pid);
            assert.equal(typeof stageParsed.token, "string");
            assert.ok(stageParsed.token.length > 0);
            verifiedPreLinkPayloadAndClosedFd = true;
          }
          realLinkSync(existingPath, newPath);
        },
      );

      await store.create({
        kind: "fact",
        key: "atomic-stage-check",
        value: "Verified pre-populated stage link and closed fd",
        provenance: "test-5a",
      });
      assert.equal(verifiedPreLinkPayloadAndClosedFd, true);
      assert.equal(openedStageFds.size, 0);

      // Simulate a failure in linkSync (EIO) and verify .stage and fd are still cleaned up
      mock.method(
        fs,
        "linkSync",
        (_existingPath: fs.PathLike, newPath: fs.PathLike): void => {
          if (String(newPath) === lockPath) {
            throw Object.assign(new Error("Simulated linkSync EIO"), { code: "EIO" });
          }
        },
      );
      await assert.rejects(
        store.create({
          kind: "fact",
          key: "stage-cleanup-on-failure",
          value: "Should fail cleanly",
          provenance: "test-5a-fail",
        }),
        /Simulated linkSync EIO/,
      );
      mock.restoreAll();

      assert.equal(openedStageFds.size, 0, "No stage fd may leak on failure");
      const stageLeftoversAfterFail = fs
        .readdirSync(tempDir)
        .filter((name) => name.endsWith(".stage") || name.endsWith(".evict"));
      assert.deepEqual(stageLeftoversAfterFail, []);

      // Part B: Fresh incomplete lock (<= INCOMPLETE_LOCK_STALE_MS) is NOT evicted on initial inspection
      workerFreshIncomplete = new Worker(__filename, {
        workerData: {
          role: "OBSERVER_WRITER",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      await waitForWorkerMessage(workerFreshIncomplete, "OPENED");

      fs.writeFileSync(lockPath, '{"createdAt":17000', { mode: 0o600 });
      const incompleteIno = fs.lstatSync(lockPath).ino;

      const checkedIncompletePromise = waitForWorkerMessage(
        workerFreshIncomplete,
        "OBSERVER_CHECKED_LOCK",
      );
      const doneIncompletePromise = waitForWorkerMessage(workerFreshIncomplete, "DONE");
      workerFreshIncomplete.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      await checkedIncompletePromise;

      // Verify the fresh incomplete lock was NOT immediately unlinked during its initial grace window
      assert.equal(fs.existsSync(lockPath), true);
      assert.equal(fs.lstatSync(lockPath).ino, incompleteIno);

      // Even WITHOUT manually unlinking lockPath, if the incomplete lock remains abandoned past
      // INCOMPLETE_LOCK_STALE_MS (500ms), workerFreshIncomplete automatically evicts it and completes!
      const doneFresh = await doneIncompletePromise;
      assert.equal(doneFresh.record.key, "record-observer");
      assert.equal(fs.existsSync(lockPath), false);
      await workerFreshIncomplete.terminate();
      workerFreshIncomplete = undefined;

      // Part C: If an old incomplete lock finishes writing valid live metadata right before .evict is acquired,
      //         tryEvictAndClaimStaleLock detects the status change (incomplete -> valid) on the SAME inode and aborts eviction!
      const dbPath5c = join(tempDir, "race-5c.sqlite");
      const lockPath5c = `${dbPath5c}.lock`;
      await MemoryStore.open(dbPath5c);

      Atomics.store(ctrl, IDX_PHASE, PHASE_INIT);
      workerTransitioned = new Worker(__filename, {
        workerData: {
          role: "B",
          dbPath: dbPath5c,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      await waitForWorkerMessage(workerTransitioned, "OPENED");

      fs.writeFileSync(lockPath5c, '{"createdAt":', { mode: 0o600 });
      fs.utimesSync(lockPath5c, 0, 0);
      const sameIno = fs.lstatSync(lockPath5c).ino;

      const bBeforeEvict5c = waitForWorkerMessage(workerTransitioned, "B_BEFORE_EVICT");
      workerTransitioned.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      await bBeforeEvict5c;

      // Now complete writing valid live metadata IN-PLACE into the exact same inode!
      fs.writeFileSync(
        lockPath5c,
        JSON.stringify({
          createdAt: Date.now(),
          pid: process.pid,
          token: "completed-in-place-token",
        }),
      );
      assert.equal(fs.lstatSync(lockPath5c).ino, sameIno);

      // Release workerTransitioned -> it acquires .evict, re-inspects lockPath5c, sees status is now "valid"
      // (no longer matching the "incomplete" candidate), and aborts eviction without overwriting lockPath5c!
      const bAborted5c = waitForWorkerMessage(workerTransitioned, "B_EVICT_ABORTED");
      const bDone5c = waitForWorkerMessage(workerTransitioned, "DONE");
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_B);
      Atomics.notify(ctrl, IDX_PHASE);
      await bAborted5c;

      assert.equal(fs.existsSync(lockPath5c), true);
      assert.equal(fs.lstatSync(lockPath5c).ino, sameIno);
      assert.equal(
        (JSON.parse(fs.readFileSync(lockPath5c, "utf8")) as { token: string }).token,
        "completed-in-place-token",
      );

      fs.unlinkSync(lockPath5c);
      const done5c = await bDone5c;
      assert.equal(done5c.record.key, "record-b");
      await workerTransitioned.terminate();
      workerTransitioned = undefined;

      // Part D: Abandoned incomplete lock with mtimeMs skewed 24 hours in the FUTURE
      //         cannot block eviction forever — monotonic observation age evicts it after INCOMPLETE_LOCK_STALE_MS!
      fs.writeFileSync(lockPath, '{"incomplete":true', { mode: 0o600 });
      const futureSeconds = Math.floor((Date.now() + 86_400_000) / 1000);
      fs.utimesSync(lockPath, futureSeconds, futureSeconds);

      const recoveredFutureMtime = await store.create({
        kind: "fact",
        key: "recovered-future-mtime-incomplete",
        value: "Evicted despite future mtimeMs",
        provenance: "test-5d",
      });
      assert.equal(recoveredFutureMtime.key, "recovered-future-mtime-incomplete");
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      mock.restoreAll();
      Atomics.store(ctrl, IDX_PHASE, PHASE_ABORT);
      Atomics.notify(ctrl, IDX_PHASE);
      await Promise.allSettled([
        workerFreshIncomplete?.terminate() ?? Promise.resolve(0),
        workerTransitioned?.terminate() ?? Promise.resolve(0),
      ]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("M-2 (6): pre-commit write fence and retry prevent silent Lost Update under concurrent writes", async () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), "jarvis-m2-race-6-"));
    const dbPath = join(tempDir, "race-6.sqlite");
    const lockPath = `${dbPath}.lock`;
    const syntheticDeadPid = process.pid === 424_242 ? 424_243 : 424_242;
    const sharedBuffer = new SharedArrayBuffer(4 * 4);
    const ctrl = new Int32Array(sharedBuffer);
    Atomics.store(ctrl, IDX_PHASE, PHASE_INIT);
    Atomics.store(ctrl, IDX_A_ACTIVE, 0);

    let workerA: Worker | undefined;
    let workerB: Worker | undefined;

    try {
      const storeC = await MemoryStore.open(dbPath);
      await storeC.create({
        kind: "fact",
        key: "seed",
        value: "Initial baseline record",
        provenance: "setup",
      });

      workerA = new Worker(__filename, {
        workerData: {
          role: "A_FENCE",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      workerB = new Worker(__filename, {
        workerData: {
          role: "B",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });

      await Promise.all([
        waitForWorkerMessage(workerA, "OPENED"),
        waitForWorkerMessage(workerB, "OPENED"),
      ]);

      // 1. Start A -> A acquires lock tokenA, loads snapshot ["seed"], writes .pending,
      //    and pauses at A_BEFORE_FENCE right before isWriteFenceValid() and renameSync().
      const aBeforeFencePromise = waitForWorkerMessage(workerA, "A_BEFORE_FENCE");
      workerA.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      await aBeforeFencePromise;

      const pendingBeforeBC = fs
        .readdirSync(tempDir)
        .filter((name) => name.endsWith(".pending"));
      assert.equal(pendingBeforeBC.length, 1);

      // 2. Forcibly unlink A's live lock while A is suspended with the stale ["seed"] snapshot,
      //    then let B and C commit record-b and record-c to disk!
      fs.unlinkSync(lockPath);

      const bDonePromise = waitForWorkerMessage(workerB, "DONE");
      workerB.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      const bDone = await bDonePromise;
      assert.equal(bDone.record.key, "record-b");

      const recordC = await storeC.create({
        kind: "fact",
        key: "record-c",
        value: "Committed by Writer C",
        provenance: "main-c",
      });
      assert.equal(recordC.key, "record-c");

      // 3. Verify on disk BEFORE resuming A: seed, record-b, and record-c are on disk, record-a is not yet committed.
      const diskBeforeA = await MemoryStore.openReadOnly(dbPath);
      assert.notEqual(await diskBeforeA.get("seed"), null);
      assert.notEqual(await diskBeforeA.get("record-b"), null);
      assert.notEqual(await diskBeforeA.get("record-c"), null);
      assert.equal(await diskBeforeA.get("record-a"), null);

      // 4. Resume A -> isWriteFenceValid() detects that A's lock was lost and dbPath changed,
      //    aborts the stale renameSync, cleans up the stale .pending file, and retries on the fresh snapshot!
      const aDonePromise = waitForWorkerMessage(workerA, "DONE");
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_A);
      Atomics.notify(ctrl, IDX_PHASE);
      const aDone = await aDonePromise;
      assert.equal(aDone.record.key, "record-a");

      // 5. Final verification on disk: ZERO Lost Updates! All 4 records (seed, record-a, record-b, record-c) are preserved!
      const diskAfterA = await MemoryStore.openReadOnly(dbPath);
      assert.notEqual(await diskAfterA.get("seed"), null);
      assert.notEqual(await diskAfterA.get("record-a"), null);
      assert.notEqual(
        await diskAfterA.get("record-b"),
        null,
        "record-b must NOT be lost when Writer A's stale snapshot is fenced and retried.",
      );
      assert.notEqual(
        await diskAfterA.get("record-c"),
        null,
        "record-c must NOT be lost when Writer A's stale snapshot is fenced and retried.",
      );

      const leftovers = fs
        .readdirSync(tempDir)
        .filter(
          (name) =>
            name.endsWith(".lock") ||
            name.endsWith(".evict") ||
            name.endsWith(".stage") ||
            name.endsWith(".pending"),
        );
      assert.deepEqual(leftovers, []);
    } finally {
      mock.restoreAll();
      Atomics.store(ctrl, IDX_PHASE, PHASE_ABORT);
      Atomics.notify(ctrl, IDX_PHASE);
      await Promise.allSettled([
        workerA?.terminate() ?? Promise.resolve(0),
        workerB?.terminate() ?? Promise.resolve(0),
      ]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("M-2 (7): deterministic TOCTOU verification-to-deletion race tests for acquireEvictLock and releaseMainLockIfOwned vs tryEvictAndClaimStaleLock", async () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), "jarvis-m2-race-7-"));
    const dbPath = join(tempDir, "race-7.sqlite");
    const lockPath = `${dbPath}.lock`;
    const evictLockPath = `${lockPath}.evict`;
    const syntheticDeadPid = process.pid === 424_242 ? 424_243 : 424_242;
    const sharedBuffer = new SharedArrayBuffer(4 * 4);
    const ctrl = new Int32Array(sharedBuffer);

    let workerEvictLoser: Worker | undefined;
    let workerHoldEvict: Worker | undefined;
    let workerConcurrentEvictor: Worker | undefined;

    try {
      await MemoryStore.open(dbPath);

      // Part A: In acquireEvictLock, Worker pauses AFTER inspectLockFile(staleEntryPath) verification
      //         right on the unlinkSync(staleEntryPath) syscall. While paused, staleEntryPath is replaced
      //         by a live replacement .evict token! Verify that resuming unlinkSync + tryCreateEvictLock
      //         does NOT delete the replacement .evict token!
      Atomics.store(ctrl, IDX_PHASE, PHASE_INIT);
      workerEvictLoser = new Worker(__filename, {
        workerData: {
          role: "EVICT_ACQUIRE_TOCTOU",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      await waitForWorkerMessage(workerEvictLoser, "OPENED");

      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          createdAt: 0,
          pid: syntheticDeadPid,
          token: "stale-main-for-7a",
        }),
        { mode: 0o600 },
      );
      seedEvictLockDir(evictLockPath, {
        createdAt: 0,
        pid: syntheticDeadPid,
        token: "stale-evict-0",
      });

      const atStaleUnlinkPromise = waitForWorkerMessage(
        workerEvictLoser,
        "EVICT_ACQUIRE_AT_UNLINK",
      );
      const acquireAbortedPromise = waitForWorkerMessage(
        workerEvictLoser,
        "EVICT_ACQUIRE_ABORTED",
      );
      const loserDonePromise = waitForWorkerMessage(workerEvictLoser, "DONE");
      workerEvictLoser.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      const { staleEntryPath } = await atStaleUnlinkPromise;

      // Replace stale-evict-0 with a live replacement .evict lock right before workerEvictLoser executes unlinkSync!
      fs.unlinkSync(staleEntryPath);
      const { entryPath: winnerEntryPath, ino: winnerIno } = seedEvictLockDir(
        evictLockPath,
        {
          createdAt: Date.now(),
          pid: process.pid,
          token: "winner-evict-token",
        },
      );

      // Resume workerEvictLoser -> it executes unlinkSync(staleEntryPath) (ENOENT) and tryCreateEvictLock (ENOTEMPTY)
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_B);
      Atomics.notify(ctrl, IDX_PHASE);
      await acquireAbortedPromise;

      // Verify winner-evict-token is 100% intact on disk!
      assert.equal(fs.existsSync(evictLockPath), true);
      assert.equal(fs.existsSync(winnerEntryPath), true);
      assert.equal(fs.lstatSync(winnerEntryPath).ino, winnerIno);
      assert.equal(
        (JSON.parse(fs.readFileSync(winnerEntryPath, "utf8")) as { token: string }).token,
        "winner-evict-token",
      );

      // Now release winner-evict-token so workerEvictLoser can acquire .evict, evict stale-main-for-7a, and finish
      cleanupEvictLockDir(evictLockPath);
      const loserDone = await loserDonePromise;
      assert.equal(loserDone.record.key, "record-evict-acquire-toctou");
      await workerEvictLoser.terminate();
      workerEvictLoser = undefined;

      // Part B: Synchronization between releaseMainLockIfOwned (in finally) and tryEvictAndClaimStaleLock.
      //         Worker A holds .evict inside releaseMainLockIfOwned, verifies inspectLockFile(lockPath),
      //         and pauses right on unlinkSync(lockPath). While paused, Worker B attempts to evict lockPath.
      //         Verify .evict prevents Worker B from creating a replacement lock before Worker A's unlinkSync,
      //         and that once Worker A finishes unlinkSync and releases .evict, Worker B's replacement lock is never deleted!
      const dbPath7b = join(tempDir, "race-7b.sqlite");
      const lockPath7b = `${dbPath7b}.lock`;
      const evictLockPath7b = `${lockPath7b}.evict`;
      await MemoryStore.open(dbPath7b);

      Atomics.store(ctrl, IDX_PHASE, PHASE_INIT);
      workerHoldEvict = new Worker(__filename, {
        workerData: {
          role: "A_RELEASE_HOLD_EVICT",
          dbPath: dbPath7b,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      workerConcurrentEvictor = new Worker(__filename, {
        workerData: {
          role: "OBSERVER_WRITER",
          dbPath: dbPath7b,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });

      await Promise.all([
        waitForWorkerMessage(workerHoldEvict, "OPENED"),
        waitForWorkerMessage(workerConcurrentEvictor, "OPENED"),
      ]);

      const atUnlinkInsideEvictPromise = waitForWorkerMessage(
        workerHoldEvict,
        "A_RELEASE_AT_UNLINK_INSIDE_EVICT",
      );
      const holdEvictDonePromise = waitForWorkerMessage(workerHoldEvict, "DONE");
      workerHoldEvict.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      const { inoA } = await atUnlinkInsideEvictPromise;

      // Verify .evict directory exists and is held by workerHoldEvict while it is paused right before unlinkSync(lockPath7b)
      assert.equal(fs.existsSync(evictLockPath7b), true);
      assert.equal(fs.lstatSync(evictLockPath7b).isDirectory(), true);

      // Start workerConcurrentEvictor while workerHoldEvict is paused right before unlinkSync(lockPath7b)
      const observerCheckedPromise = waitForWorkerMessage(
        workerConcurrentEvictor,
        "OBSERVER_CHECKED_LOCK",
      );
      const observerDonePromise = waitForWorkerMessage(workerConcurrentEvictor, "DONE");
      workerConcurrentEvictor.postMessage({
        cmd: "START_CREATE",
      } satisfies MainToWorkerMessage);
      await observerCheckedPromise;

      // Verify lockPath7b has NOT been replaced while workerHoldEvict holds .evict
      assert.equal(fs.existsSync(lockPath7b), true);
      assert.equal(fs.lstatSync(lockPath7b).ino, inoA);

      // Resume workerHoldEvict -> it unlinks its own lockA and releases .evict,
      // and workerConcurrentEvictor then cleanly acquires its replacement lock and commits!
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_A);
      Atomics.notify(ctrl, IDX_PHASE);

      const [holdDone, observerDone] = await Promise.all([
        holdEvictDonePromise,
        observerDonePromise,
      ]);
      assert.equal(holdDone.record.key, "record-a-hold-evict");
      assert.equal(observerDone.record.key, "record-observer");

      const roStore7b = await MemoryStore.openReadOnly(dbPath7b);
      assert.notEqual(await roStore7b.get("record-a-hold-evict"), null);
      assert.notEqual(await roStore7b.get("record-observer"), null);
      assert.equal(fs.existsSync(lockPath7b), false);
      assert.equal(fs.existsSync(evictLockPath7b), false);
    } finally {
      Atomics.store(ctrl, IDX_PHASE, PHASE_ABORT);
      Atomics.notify(ctrl, IDX_PHASE);
      await Promise.allSettled([
        workerEvictLoser?.terminate() ?? Promise.resolve(0),
        workerHoldEvict?.terminate() ?? Promise.resolve(0),
        workerConcurrentEvictor?.terminate() ?? Promise.resolve(0),
      ]);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("M-2 (8): stage cleanup race - cleanupStaleStageFiles never removes stage of live process even if age exceeds threshold", async () => {
    const tempDir = fs.mkdtempSync(join(tmpdir(), "jarvis-m2-race-8-"));
    const dbPath = join(tempDir, "race-8.sqlite");
    const lockPath = `${dbPath}.lock`;
    const evictLockPath = `${lockPath}.evict`;
    const syntheticDeadPid = process.pid === 424_242 ? 424_243 : 424_242;
    const sharedBuffer = new SharedArrayBuffer(4 * 4);
    const ctrl = new Int32Array(sharedBuffer);
    Atomics.store(ctrl, IDX_PHASE, PHASE_INIT);

    let workerA: Worker | undefined;

    try {
      await MemoryStore.open(dbPath);

      // Start Creator A
      workerA = new Worker(__filename, {
        workerData: {
          role: "STAGE_CREATOR_A",
          dbPath,
          syntheticDeadPid,
          sharedBuffer,
        } satisfies RaceWorkerData,
        execArgv: [],
      });
      await waitForWorkerMessage(workerA, "OPENED");

      const pausedPromise = waitForWorkerMessage(workerA, "STAGE_CREATOR_A_PAUSED");
      workerA.postMessage({ cmd: "START_CREATE" } satisfies MainToWorkerMessage);
      const { stageDirPath, stageToken } = await pausedPromise;

      // Creator A is now paused right after writing its stage ownership marker and BEFORE renameSync!
      assert.equal(fs.existsSync(stageDirPath), true);
      const stageTokenFile = join(stageDirPath, `${stageToken}.lock`);
      assert.equal(fs.existsSync(stageTokenFile), true);

      // Verify the owner PID inside the stage file is indeed workerA (which is alive)
      const stageContent = JSON.parse(fs.readFileSync(stageTokenFile, "utf8")) as {
        pid: number;
        token: string;
      };
      assert.equal(stageContent.token, stageToken);
      assert.notEqual(stageContent.pid, syntheticDeadPid);

      // Make the stage directory and its marker file appear older than the cleanup threshold (> 500ms and > 30s)
      const oldTimeSeconds = Math.floor((Date.now() - 60_000) / 1000);
      fs.utimesSync(stageTokenFile, oldTimeSeconds, oldTimeSeconds);
      fs.utimesSync(stageDirPath, oldTimeSeconds, oldTimeSeconds);

      // Now run cleanup from another store instance (Worker B / main thread store)
      // We can trigger tryEvictAndClaimStaleLock which calls cleanupStaleStageFiles,
      // or directly verify via a new store acquiring/evicting.
      // When storeB tries to acquire or evict, cleanupStaleStageFiles(lockPath) runs.
      const storeB = await MemoryStore.open(dbPath);

      // Seed a stale candidate so storeB.acquireLock or tryEvict triggers cleanupStaleStageFiles
      // Actually, storeB.acquireLock -> inspectLockFile -> if not stale, it tries tryCreateLockFile -> which calls acquireEvictLock -> which calls cleanupStaleStageFiles(evictDirPath)!
      // Let's seed a dead lockPath so acquireLock calls tryEvictAndClaimStaleLock(lockPath) -> cleanupStaleStageFiles(lockPath)!
      // But notice lockPath does not exist right now, so storeB.create would try to acquire the lock.
      // Since workerA currently holds nothing yet (it's paused in creating .evict),
      // if storeB attempts to create a record, it will try to create .lock -> acquireEvictLock -> cleanupStaleStageFiles(evictLockPath)!
      // And stageDirPath is `${evictLockPath}.${token}.stage`, so targetPath in cleanupStaleStageFiles(evictLockPath) matches!
      // To run cleanup without blocking on the lock:
      // Let's call storeB.create in a background attempt or trigger cleanup directly.
      // But storeB acquiring evict will see stageDirPath in readdirSync(dir)!
      // Wait, let's test directly that cleanupStaleStageFiles on evictLockPath does NOT delete stageDirPath.
      // We can invoke with a store call or call the private cleanupStaleStageFiles via (storeB as any).cleanupStaleStageFiles(lockPath) and (storeB as any).cleanupStaleStageFiles(evictLockPath):
      (storeB as unknown as { cleanupStaleStageFiles: (p: string) => void }).cleanupStaleStageFiles(lockPath);
      (storeB as unknown as { cleanupStaleStageFiles: (p: string) => void }).cleanupStaleStageFiles(evictLockPath);

      // CRITICAL ASSERTION: B did NOT delete A's active stage directory or marker file,
      // even though its age exceeded the stale threshold, because workerA is a live process!
      assert.equal(
        fs.existsSync(stageDirPath),
        true,
        "Stage directory must NOT be deleted while creating process is alive!",
      );
      assert.equal(
        fs.existsSync(stageTokenFile),
        true,
        "Stage token file must NOT be deleted while creating process is alive!",
      );

      // Now resume Creator A: it completes renameSync and commits its write successfully!
      const aDonePromise = waitForWorkerMessage(workerA, "DONE");
      Atomics.store(ctrl, IDX_PHASE, PHASE_RELEASE_A);
      Atomics.notify(ctrl, IDX_PHASE);

      const aDone = await aDonePromise;
      assert.equal(aDone.record.key, "record-stage-creator-a");

      // Verify the record was committed to the DB
      const roStore = await MemoryStore.openReadOnly(dbPath);
      assert.notEqual(await roStore.get("record-stage-creator-a"), null);

      // Verify all locks and stage files were cleaned up after completion
      assert.equal(fs.existsSync(lockPath), false);
      assert.equal(fs.existsSync(evictLockPath), false);
      assert.equal(fs.existsSync(stageDirPath), false);
    } finally {
      Atomics.store(ctrl, IDX_PHASE, PHASE_ABORT);
      Atomics.notify(ctrl, IDX_PHASE);
      await workerA?.terminate();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}
