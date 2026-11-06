# Memory Deletion and Restoration Design Proposal

lifecycle_status: PROPOSED\
owner_approval: NOT_APPROVED\
implementation_authorized: false

> **Document status:** This is a standalone, non-binding design
> proposal. It does not approve any owner decision, close any technical
> evidence item, authorize implementation, or modify the existing Jarvis
> decision record.

## 1. Purpose and scope

This document consolidates the reviewed conceptual design for safely
blocking, restoring, and permanently purging stored Jarvis memories.

The design separates three distinct guarantees:

1.  **Preventing use:** data subject to deletion or restoration must not
    be read or used while its status is unresolved or blocked.
2.  **Preventing stale writes:** an operation that began earlier must
    not reintroduce or overwrite data after a newer blocking or
    ownership transition.
3.  **Permanent deletion:** the targeted memory version and its history
    must be physically removed, with durable evidence that the purge
    operation was executed and verified.

These guarantees are related but are not interchangeable. A tombstone
can support access blocking; it does not by itself prove that stale
writes are impossible or that all copies have been purged.

### Scope boundaries

This proposal covers conceptual state transitions, evidence, crash
recovery, SQLite transaction behavior, and fencing requirements. It does
not prescribe immediate code changes.

It does not authorize: - Phase A or Phase B implementation; - changes to
`D-01` through `D-13` or A.9; - approval of OD-03, MI-01, MI-02, D-03,
or any other owner decision; - changes to the current database, source
code, tests, or configuration.

## 2. Current state versus proposed design

### 2.1 Current state reported by prior Kilo audits

The following statements describe the state reported by previous project
audits. They are not a fresh inspection performed while preparing this
proposal.

-   The current memory implementation was reported to use `sql.js` with
    a `MemoryStore`.
-   The reported tables are `memories` and `memory_history`.
-   The reported `memories` columns are `id`, `kind`, `key`, `value`,
    `provenance`, `version`, `created_at`, and `updated_at`, with `id`
    as primary key and `key` unique.
-   The reported `memory_history` columns are `id`, `kind`, `key`,
    `value`, `provenance`, `version`, `created_at`, and `updated_at`,
    with a reported composite primary key involving `id` and `version`.
-   Prior audits reported no implemented `delete()`, `purge()`, or
    `restore()` lifecycle functions.
-   Prior audits reported no implemented tombstone table,
    `restore_state` barrier, `purge_execution_log`, or Fencing Token
    enforcement.
-   Prior audits reported no explicit SQL transaction wrapping the
    relevant block-check-and-write sequence.
-   The current `sql.js` export-to-file approach does not, by itself,
    establish the crash-durability guarantees of native SQLite.
-   Prior audits did not establish a managed backup/replica lifecycle
    for Jarvis. This does not establish anything about external copies
    or backups outside the inspected project.
-   `containsSensitiveContent` was reported as a privacy filter in the
    save/provider path. It is not evidence of a deletion mechanism for
    sensitive data already stored.
-   The meaning and technical implementation of Delete Barrier remain
    unresolved in MI-02.
-   The Protected Store technology remains unresolved in MI-01.
-   OD-03, the physical-deletion policy decision, remains open.
-   TE-01 through TE-08 remain technical evidence requirements according
    to the prior project status.

The table definitions and implementation details above must be
re-verified against the actual schema and code before any implementation
plan relies on them.

### 2.2 Proposed future components

The following are **proposals only**, not existing Jarvis capabilities:

-   a durable access-blocking tombstone or equivalent;
-   an independent durable restoration barrier (`restore_state`);
-   a purge execution evidence table such as `purge_execution_log`;
-   a trusted generation/epoch and storage-enforced fencing protocol;
-   reconciliation between database-local evidence and an external
    Journal;
-   verified, version-specific purge operations.

## 3. Separation of the three guarantees

### 3.1 Preventing use

A memory is unavailable for reads, retrieval, context construction, and
other use when any applicable deletion or restoration barrier says it is
blocked or unresolved.

A proposed access decision should fail closed if: - the relevant barrier
cannot be read; - the operation state is unknown; - the database-local
evidence and Journal conflict; - the operation is in a non-terminal
restore or deletion state.

Every read path and every write path that can expose or modify protected
memory must enforce the same policy. A check in only one API route is
insufficient.

### 3.2 Preventing stale writes

A process may hold an old in-memory copy or may have queued work before
a deletion or ownership transition. Blocking reads does not
automatically stop that process from writing later.

The proposed design therefore requires storage-enforced
generation/fencing checks for operations that may outlive the
transaction or ownership epoch in which they began. The check must be
enforced atomically with the protected write.

### 3.3 Permanent deletion

Purge must target a specific memory identity/version, not merely a
reusable logical key. It must delete the intended row(s) and associated
history, preserve durable evidence of execution, and verify the result.

A missing row alone is not sufficient evidence that a particular purge
operation executed successfully.

## 4. Proposed Restore lifecycle

### 4.1 Proposed barriers and states

A future design may use: - a tombstone or equivalent deletion block; - a
separate durable `restore_state` barrier; - a unique `operation_id` for
each restore attempt; - durable local execution evidence and Journal
events.

The restoration barrier must remain active throughout the incomplete
restore. Removing a tombstone must not make the memory available while
`restore_state` still blocks it.

Illustrative states:

`RESTORE_PENDING` → `RESTORE_VERIFIED` → `RESTORING` →
`RESTORE_COMPLETED`

A cancellation path may end in `RESTORE_CANCELLED`, but cancellation
must not remove the final effective access block until the prior blocked
state has been re-established and verified.

### 4.2 Proposed successful restore ordering

1.  Register the restore intent with a unique `operation_id`.
2.  Establish and durably verify the independent restoration barrier.
3.  Verify that the targeted memory data required for restoration still
    exists and is internally consistent.
4.  Record durable local evidence that verification passed.
5.  Remove the tombstone only while the restoration barrier remains
    effective.
6.  Record `RESTORE_COMPLETED` in the authoritative operation
    record/Journal, with a defined reconciliation protocol if the
    Journal is external.
7.  As the final access transition, remove the restoration barrier and
    make the memory available.
8.  Verify the resulting active state.

The exact atomic boundary between steps 6 and 7 must be designed. If the
Journal is external, a durable local completion marker and
reconciliation protocol are needed; a cross-system atomic commit must
not be assumed.

### 4.3 Proposed cancellation ordering

Cancellation must preserve the pre-restore access state.

1.  Keep `restore_state` active.
2.  Re-establish the original tombstone or an equivalent durable block
    if it was removed.
3.  Verify that the original block is effective.
4.  Record `RESTORE_CANCELLED` durably.
5.  Remove `restore_state` only after the original block is known to be
    effective.
6.  If the original state was genuinely active rather than blocked,
    restore that state only after proving that no deletion barrier or
    other restriction applies.

If the system cannot prove the prior state or re-establish the block, it
must remain blocked and report `OUTCOME_UNKNOWN`. It must not guess
whether the memory was originally active or blocked.

### 4.4 Restore crash recovery

  -----------------------------------------------------------------------
  Failure point                       Required recovery posture
  ----------------------------------- -----------------------------------
  Before restore barrier is durably   Do not assume a restore began;
  established                         preserve the previously established
                                      access state.

  After `RESTORE_PENDING`, before     Keep the restore barrier active;
  data verification                   resume only from durable intent and
                                      verified state, otherwise
                                      `OUTCOME_UNKNOWN`.

  After verification, before          Keep the restore barrier active;
  tombstone removal                   re-check evidence before
                                      continuing.

  After tombstone removal, before     Keep the restore barrier active; do
  completion is durably recorded      not expose data. Reconcile using
                                      durable local evidence and Journal.

  After completion is recorded,       Keep data blocked until
  before restore barrier removal      reconciliation proves completion;
                                      then the final activation step may
                                      be resumed idempotently.

  During cancellation                 Keep at least one effective barrier
                                      active until the original blocked
                                      state and cancellation outcome are
                                      durably established.
  -----------------------------------------------------------------------

### 4.5 Restore guarantees and limits

The proposal aims to prevent early data exposure and unsafe
cancellation. It does not yet prove: - that every read/write path will
enforce both barriers; - that the barrier and Journal can be reconciled
atomically; - that the existing storage implementation can provide the
required durability; - that the state machine has been implemented or
tested.

## 5. Proposed PURGE lifecycle

### 5.1 Target identity

A purge request must identify the exact memory instance/version it
intends to remove. A logical `key` alone is unsafe if that key can be
reused.

A future purge operation should bind its `operation_id` to stable
identity evidence, for example: - the target row's immutable `id`; - its
expected `version` or generation; - the logical key as an additional
consistency check; - the relevant history identity/version set or a
deterministic selection rule.

The actual identity fields and deletion predicate must be confirmed
against the real schema before implementation. Do not assume that
`operation_id` exists in `memories` or `memory_history`; prior audits
reported that it does not.

### 5.2 Proposed database-local execution evidence

A separate table is proposed for future consideration:

``` sql
CREATE TABLE IF NOT EXISTS purge_execution_log (
  operation_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_version TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('EXECUTED', 'VERIFIED', 'COMPLETED', 'FAILED')
  ),
  executed_at TEXT NOT NULL,
  verified_at TEXT,
  completed_at TEXT
);
```

This is illustrative, not an approved schema. Types, constraints, target
identity, and whether history requires a separate evidence set must be
decided after inspecting the actual schema.

### 5.3 Proposed purge transaction

For a storage engine capable of the required native transaction
semantics, the intended conceptual boundary is:

1.  Register `PENDING_DELETE` with a unique `operation_id` in the
    authoritative operation record.
2.  Begin a write transaction.
3.  Verify the deletion barrier and the current generation/fencing
    token.
4.  Verify that the row still matches the target immutable identity and
    expected version.
5.  Delete only the exact target row and the history belonging to that
    target, using predicates grounded in the actual schema.
6.  Insert the `purge_execution_log` record with `EXECUTED` and the same
    `operation_id`.
7.  Commit the database transaction.
8.  Reconcile the database-local execution record with the Journal,
    recording `PURGE_EXECUTED` there if the Journal is external.
9.  Perform read-back verification that the targeted row and associated
    history are absent.
10. Record `VERIFIED` evidence and then `PURGE_VERIFIED`.
11. Record `PURGE_COMPLETED` only after the required verification
    evidence is durable and reconciled.

The database-local deletion and execution marker should be committed
atomically within one database transaction. If the Journal is external,
there is still no automatic atomic transaction spanning both systems.
Reconciliation must use the durable `operation_id` and local marker; it
must not assume a distributed transaction.

### 5.4 Purge crash recovery

  -----------------------------------------------------------------------
  Failure point                       Required recovery posture
  ----------------------------------- -----------------------------------
  Before database transaction commit  Native SQLite transaction rollback
                                      should leave the transaction's
                                      changes unapplied, subject to the
                                      selected engine and durability
                                      configuration. Re-evaluate the
                                      exact target before retrying.

  After commit, before external       The database-local execution marker
  Journal event                       is evidence to reconcile the
                                      Journal. Do not repeat a broad
                                      key-based delete.

  After `PURGE_EXECUTED`, before      Verify the exact target and
  verification                        associated history by read-back.

  After verification, before          Reconcile durable verification
  `PURGE_COMPLETED`                   evidence, then complete the
                                      operation idempotently.

  Conflicting or missing evidence     Keep the memory blocked and report
                                      `OUTCOME_UNKNOWN`; do not infer
                                      success from absent rows alone.
  -----------------------------------------------------------------------

A retry must be idempotent and bound to the original target identity. A
retry for an already-absent target may proceed only when the durable
operation evidence establishes that it is the same purge operation and
the intended target. It must never delete a newly created memory that
reuses the same key.

### 5.5 Purge guarantees and limits

The proposed local marker closes an important evidence gap between
database commit and external Journal recording, provided the marker and
deletion are truly in the same durable database transaction.

It does not by itself prove deletion from: - backups or snapshots; -
replicas or caches; - exported database files; - logs or external
systems; - storage media remnants.

Those locations require a separately defined scope and policy. OD-03
remains open and must determine the owner's physical-deletion
requirements.

## 6. SQLite transactions, locks, and durability

### 6.1 `BEGIN IMMEDIATE`

With native SQLite, `BEGIN IMMEDIATE` attempts to start a write
transaction immediately. It obtains the write-reservation/ writer
position at transaction start rather than waiting until a later write
statement. This serializes competing writers to the same database file:
another writer cannot independently proceed with a conflicting write
transaction until the current writer commits or rolls back.

Readers may continue depending on the journal mode and locking state.
Exact reader/writer behavior differs between rollback-journal and WAL
modes.

A future block-check-and-write operation should perform the barrier
check, generation check, and protected mutation inside the same
transaction. All relevant write paths must follow the same protocol.

### 6.2 `BEGIN DEFERRED`

`BEGIN DEFERRED` does not immediately acquire a write transaction. A
transaction may first establish a read snapshot and later attempt to
upgrade to a write transaction. If another writer has changed the
database or holds a conflicting lock, the upgrade can fail with a
busy/locking error. The application must handle such errors by safely
rolling back and retrying only when the operation remains valid and its
evidence is rechecked.

`BEGIN DEFERRED` does not bypass SQLite locking. It simply delays
acquisition of the write transaction and can therefore expose upgrade
conflicts.

### 6.3 Protocol boundaries

Native SQLite coordinates transactions that operate on the same database
file through SQLite's locking and transaction mechanisms. This does not
protect work that: - reads data into memory and later writes it without
rechecking the current barrier/generation; - writes through a path that
bypasses the transaction protocol; - writes to a different database or
external service; - uses stale queued work after its authority has been
revoked.

Those cases require a storage-enforced generation/fencing check or an
equivalent invalidation protocol.

### 6.4 Durability configuration

A successful `COMMIT` is not an unconditional promise against every
hardware, filesystem, or power-loss failure. Durability depends on
SQLite configuration and the environment, including: -
`PRAGMA synchronous` (for example, FULL, NORMAL, or OFF); - journal mode
(for example, DELETE, WAL, MEMORY, or OFF); - filesystem and
operating-system behavior; - storage-device guarantees and failure
modes; - correct use of SQLite and its locking protocol.

The production durability profile must be selected, documented, and
tested. `synchronous=FULL` can strengthen durability but is not a
universal guarantee against faulty storage hardware or filesystems.

### 6.5 `sql.js` boundary

Prior audits report that the current implementation uses `sql.js`, which
runs SQLite-compatible database logic in a JavaScript/WebAssembly
environment and exports database contents to a file. Native SQLite
transaction and crash-durability claims must not be transferred
automatically to this export-based persistence path.

The current save/export sequence, crash windows, atomic replacement
behavior, and recovery behavior require direct technical evidence. No
such guarantee is asserted by this proposal.

## 7. Fencing Token and trusted generation protocol

### 7.1 Purpose

A Fencing Token is a monotonically ordered authority/generation value
used to reject operations whose authority is older than the latest
accepted generation. It is not merely a mutex, a worker identifier, or a
claim that only one worker exists.

### 7.2 Trusted issuer and storage

A future design must identify: - the trusted coordinator or authority
that issues generations; - the event that advances the generation, such
as revoking an owner/worker epoch or establishing a deletion barrier; -
the durable storage location for the current accepted generation; - how
issuer authority is authenticated and protected from arbitrary
workers; - how generations survive restart and recovery.

A worker must not be allowed to choose an arbitrary future generation.
The current generation must be advanced only by the trusted authority
under a defined protocol.

### 7.3 Atomic enforcement

For a single SQLite database, the conceptual enforcement is:

1.  Begin a write transaction (for example, `BEGIN IMMEDIATE`).
2.  Read the current trusted generation and operation state from the
    authoritative database-local record.
3.  Compare the operation's issued token with the current accepted
    generation and the operation's permitted state.
4.  Reject and roll back before changing protected data if the token is
    stale, unknown, revoked, or not authorized for the operation.
5.  If valid, perform the protected mutation and any required
    generation/state update in the same transaction.
6.  Commit.

The exact comparison rule must be defined. A common safe pattern is
exact equality with the currently authorized epoch for that
worker/operation, or another formally specified monotonic acceptance
rule. A check such as `token >= current_generation` is not sufficient by
itself: it can allow an untrusted or stale actor to present an arbitrary
future value. Workers must not self-advance the trusted generation.

### 7.4 Multiple workers and delayed work

-   Multiple workers may hold different tokens, but only the current
    authorized generation may pass the storage check.
-   A queued operation carrying an older token must be rejected when it
    eventually reaches storage.
-   A worker holding stale in-memory data must revalidate its token at
    the write boundary.
-   A worker that bypasses the storage gate invalidates the fencing
    guarantee; all protected write paths must be covered.
-   Cross-database or external-service writes require the receiving
    storage system to enforce the token too. A token checked only by the
    coordinator does not fence a downstream store that accepts stale
    writes.

### 7.5 Fencing limits and open design choices

The proposal does not yet choose the issuer architecture, token scope,
generation lifecycle, worker identity model, or cross-store protocol.
These require owner/design decisions and technical evidence.

## 8. Crash recovery, reconciliation, and fail-closed behavior

### 8.1 General rules

-   Every operation must have a durable unique `operation_id`.
-   Evidence must distinguish intent, execution, verification, and
    completion.
-   Database-local state and Journal state must be reconciled explicitly
    when they are separate systems.
-   A missing Journal event must not erase valid database-local
    evidence; a missing database marker must not be invented from a
    Journal intent.
-   Conflicting, incomplete, or unavailable evidence leads to
    `OUTCOME_UNKNOWN` and continued blocking.
-   Reconciliation must be idempotent, target-specific, and safe to
    resume after another crash.
-   Reconciliation must never reactivate data merely because a row is
    present or absent.

### 8.2 Evidence hierarchy

The final source of truth and precedence between: - database-local
barriers; - database-local execution markers; - Journal intent/events; -
generation/fencing records; - verified read-back results

must be formally specified. No component should be called the sole
source of truth until its consistency, durability, and failure behavior
are established.

### 8.3 Fail-closed cases

Access must remain blocked when: - the barrier store cannot be read; -
the generation cannot be verified; - restore or purge evidence
conflicts; - a completion event is missing and no approved
reconciliation rule resolves it; - a worker's authority is stale or
uncertain; - a storage commit outcome is unknown.

## 9. Remaining decisions and technical evidence

The following are reported as open and must remain open until formally
resolved through the project's owner-decision process:

  -----------------------------------------------------------------------
  Item                                Required resolution/evidence
  ----------------------------------- -----------------------------------
  OD-03                               Owner decision defining physical
                                      deletion policy and required scope.

  MI-01                               Selection and justification of
                                      Protected Store/storage technology
                                      and its guarantees.

  MI-02                               Precise definition, scope,
                                      lifecycle, and enforcement meaning
                                      of Delete Barrier; distinguish it
                                      from fencing/admission mechanisms.

  D-03                                Owner decision for the relevant
                                      pre-claim/gating/fencing behavior;
                                      no approval is implied here.

  TE-01                               Prove atomic enforcement of the
                                      fencing/generation check with the
                                      actual protected write.

  TE-02                               Prove conditional storage rejection
                                      and fail-closed behavior.

  TE-03                               Prove stale/late writes cannot
                                      commit after a blocking transition.

  TE-04                               Define and prove handling of
                                      partial data after cancellation or
                                      unknown outcomes.

  TE-05                               Define and prove treatment of
                                      backups, caches, replicas, and
                                      other copies within the approved
                                      deletion scope.

  TE-06                               Prove data cannot be used while
                                      physically present but logically
                                      blocked.

  TE-07                               Prove detection and safe handling
                                      of orphaned data without
                                      trustworthy Journal/evidence.

  TE-08                               Define and prove the relationship
                                      between the relevant fencing token
                                      and D-03.
  -----------------------------------------------------------------------

The precise list and status of technical evidence items must be checked
against the current decision document before being used as an
implementation checklist. This proposal does not amend that document.

## 10. Residual risks and non-goals

Even if the proposed mechanisms are implemented, further work is
required to prove: - every read, write, retrieval, context-building, and
export path enforces the barriers; - every asynchronous job and worker
is fenced at the actual storage boundary; - database-local markers and
external Journal reconciliation survive all relevant crash points; -
backups, replicas, and exports are handled according to the owner's
deletion policy; - restore cannot reopen access before completion or
after cancellation; - a purge cannot delete a newer memory that reuses a
logical key; - storage durability matches the declared failure model.

This document does not claim production safety, implementation
readiness, or verified behavior.

## 11. Final status

**Design assessment:** The lifecycle is a coherent conceptual proposal
for owner review, subject to the unresolved details and evidence listed
above.

**Owner approval:** Not approved.

**Implementation authorization:** Not authorized.

**Implementation readiness:** Not ready. No part of this proposal is
authorized for immediate implementation by this document.

No existing decision, A.9 text, owner-decision status, source code,
test, configuration, or database state is changed by this proposal.
