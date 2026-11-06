# Delivery Gate | The only component permitted to invoke a Resu Jarvis Memory Architecture v3.6

Status: Consolidated corrective design proposal — not approved for implementation.

Document date: 2026-11-03
Corrects: `docs/jarvis-memory-architecture-v3.5.md`

This is a standalone architecture document. It preserves the v3.5 decisions and adds narrowly scoped corrections for dispatch/delete ordering, protected payload binding, deletion outcome reporting, Memory Event Log placement, evaluation criteria, generation semantics, and traceability. It is not evidence that any mechanism is implemented or security-tested.

Historical source limitation: the only architecture documents available in the project are v3.4 and v3.5. The supplied historical summaries and this request are used as evidence where identified; original v1.0-v3.3 documents were not available, so exact first-release attribution is not invented.

No code, database, schema, personal data, credentials, application, test, simulation, deletion, encryption operation, or external service is authorized. Phase A and Phase B remain unauthorized.

## 1. Purpose, Scope and Non-Goals

### 1.1 Purpose

Specify Jarvis memory boundaries, temporal semantics, append-only event history, encryption, Coordinator ordering, send and delivery authorization, witness anchoring, deletion, recovery, retrieval, consolidation, skill evaluation, and privacy review.

The central objective is to prevent ambiguous ordering, stale authority, unknown external outcomes, stale backups, or unverified deletion from being reported as success or used to reopen visibility.

### 1.2 Scope

This version preserves v3.5 and corrects the following explicit ambiguities:

- `SEND_STARTED` and `DELIVERY_STARTED` identify local operation start, not Adapter invocation or external delivery.
- Adapter invocation is a separately ordered boundary that competes with the delete barrier.
- Payload verification commitments are protected separately from public journal/witness metadata.
- Locally verified deletion and externally verified effects/deletion are distinct outcomes.
- Memory Event Log is explicitly a logical event category within the Coordinator Journal; projections are rebuildable.
- Historical Retrieval Evaluation, Skill Evaluation, and Vertical Slice criteria are restored as unverified future criteria.
- Coordinator Epoch, Fencing Generation, Key Generation, Deletion Revision, Witness Revision, and Journal Revision have separate definitions.

### 1.3 Non-goals and authority limits

This document is not a production implementation specification, proof of security, privacy claim, vendor/database/cryptographic selection, or authorization to begin implementation or either phase. It does not claim that a provider can retract an operation already accepted. Any new mechanism marked as a proposal remains subject to approval.

## 2. Architecture Principles and Security Invariants

These are architectural requirements. Their presence in a document is not implementation evidence.

1. The Coordinator Journal is the sole authority for committed event ordering. No projection, request timestamp, worker, adapter, or witness creates a competing event order.
2. `request_sequence` orders durably admitted requests; it is not a commit or authorization. `commit_sequence` is monotonic and never reused, and is assigned only in the Coordinator transaction that commits the event.
3. Coordinator Admission State is a projection of committed Coordinator Journal events and cannot be an independent source of order.
4. Provider Send and Result Delivery are separately authorized and separately evidenced operations.
5. `SEND_AUTHORIZED` / `DELIVERY_AUTHORIZED` bind the exact final payload, destination, policy, and transformation version through a protected binding record.
6. `SEND_STARTED` / `DELIVERY_STARTED` mean the local Coordinator accepted operation start. Neither proves Adapter invocation, bytes leaving the device, provider receipt, handoff, or user receipt.
7. Adapter invocation has its own serialized gate and evidence. A Coordinator transaction cannot atomically transact with a remote provider or receiver.
8. Unknown outcomes never turn automatically into success, rejection, or a retry. Human approval cannot manufacture evidence of an external result.
9. A stale worker cannot use an old grant after a delete barrier commits. All Adapter calls must pass the single current Egress/Delivery Gate and current fencing generation.
10. A local barrier blocks new dispatch; it cannot retract a call that crossed the Adapter invocation boundary before the barrier. Such work is tracked independently and may remain externally unknown.
11. Deletion is witness-first. A tombstone is anchored before destruction of its data keys. Once anchored, deletion moves forward and cannot be rolled back.
12. Local deletion completion is not proof of provider-side deletion. No external deletion claim is made without provider evidence under an approved contract.
13. No old key generation, tombstone, permission, receipt, lease, or backup can reactivate deleted data or authorize a new operation.
14. Loss of Protected Link Store never authorizes heuristic reconstruction.
15. No unknown temporal boundary is guessed. Facts, inferences, and hypotheses remain distinguished, with provenance and revision history.
16. STM, WM, LTM, and non-personal Knowledge Base remain logically separated. Retrieval is task-scoped and bounded; no request sends the whole memory store by default.
17. Sleep-time consolidation creates reviewable proposals, not automatic writes. Skills are versioned, independently evaluated, reviewable, and reversible.
18. Metadata privacy is a threat and a measurement requirement, not an achieved property.

## 3. Complete System Components and Trust Boundaries

| Component | Role and boundary |
|---|---|
| Coordinator Service | Serializes per-scope admission, dispatch gates, deletion barriers, policy checks, and committed transitions. Sole commit authority. |
| Coordinator Journal | Canonical append-only event journal; carries all committed order and commit sequence. Physical technology is unselected. |
| Memory Event Log | Logical subset/category of Coordinator Journal events for memory changes; not an independent store of canonical order. |
| Coordinator Admission State | Rebuildable current admission/barrier projection of committed Coordinator events. |
| Request Inbox | Durable request queue. `request_sequence` arbitrates accepted requests but grants no permission. |
| Egress Gate | The only component permitted to invoke a Provider Adapter. Serializes dispatch boundary against deletion for a scope. |
|lt Delivery Adapter. Applies the same ordering and fencing rules as Egress Gate. |
| Provider / Delivery Adapters | External boundary. Cannot join the Coordinator transaction; may have irreversible or unknown effects. |
| Protected Egress Staging Store | Stores exact final encrypted payload bytes pending authorized send. |
| Payload Binding Vault | Stores per-operation protected payload-binding commitments and restricted mapping to grant/operation. No public/plaintext digest is stored in the event envelope or witness manifest. |
| Protected Receipt Store | Holds authenticated Adapter receipts and content-bearing response details under restricted encryption; journal holds only minimized status/reference. |
| Memory Content Store | Encrypted content blobs separated from event envelopes and projections. Physical store is unselected. |
| Current Projections and Indexes | Rebuildable current memory, graph, search, cache, embedding, and context views. Not authoritative. |
| Knowledge Base | Non-personal sourced knowledge in separate namespace, access policy, retention, and key domain from personal memory. |
| Key Store / Key Generation Ledger | Holds key status and generation floors; exact KMS/OS/HSM choice is unapproved. |
| Deletion Ledger / Tombstone Store | Tracks opaque deletion operations and revisions; reconciled against Coordinator and Witness. |
| Protected Link Store | Separately encrypted mapping from opaque subject/scope tokens to affected objects and artifacts. Loss means no guessing. |
| Witness | External anchoring service. Trust, monotonicity, freshness, retention, idempotency, and outage contract are BLOCKERS. |
| Trusted Time Source | Required only for explicitly time-dependent lease/freshness policies. Wall clock alone cannot order events. |
| Visibility Gate | Blocks data/context/key release until restore and deletion checks pass. Defaults closed on startup/recovery. |
| Backup / Restore Manager | Reconciles snapshots against current journal, witness, tombstones, and key-generation floors before visibility. |
| Consolidation Worker | Local resumable proposal generation; no implicit network call or confirmed-memory write. |
| Skill Registry / Evaluator | Stores immutable skill versions, independent evaluation evidence, approval, and rollback pointer. |
| Privacy Router | Enforces local/cloud classification and policy; uncertainty or sensitive classification never falls back to cloud. |

### 3.1 Trust boundaries

- Local locks serialize only their process and do not provide durability or rollback resistance.
- The Coordinator store must atomically commit journal event, commit sequence, operation state, and Coordinator-owned Admission State projection.
- The Coordinator cannot atomically commit with Witness, Adapter, external receiver, or a physically separate projection store.
- The Egress/Delivery Gate is the sole Adapter caller; workers cannot hold transferable Adapter credentials or bypass current fencing validation.
- Witness receives only a minimized system-level manifest; it is not trusted to reconstruct missing event payloads.
- Encryption does not hide sizes, event cadence, or metadata correlation.

### 3.2 Consistency Token

An operation-specific Coordinator Consistency Token binds opaque one-time operation ID, Coordinator Epoch, Fencing Generation, committed `commit_sequence`, Journal Revision, policy/authorization revision, protected payload-binding reference, destination binding, applicable Key Generation and Deletion Revision, and the required Witness/manifest status. Token fields that can reveal personal content or stable identity are protected; the token is audience-limited, non-transferable, current-fence checked, and cannot replace journal or witness evidence.

## 4. Memory Data Model and Bitemporal Semantics

### 4.1 Memory classes

- **Short-Term Memory (STM):** recent session events with explicit TTL/capacity; no automatic LTM promotion.
- **Working Memory (WM):** temporary values isolated by task ID and bounded by an approved expiry/capacity policy.
- **Long-Term Memory (LTM):** durable, user-specific facts, preferences, goals, projects, decisions, and reviewed inferences.
- **Knowledge Base (KB):** non-personal, sourced reference knowledge; separate namespace, authorization, retention, and keys from personal memory.
- **Consolidation proposals:** non-authoritative candidates pending review.
- **Skills:** versioned artifacts, not facts, with separate evaluation and execution authorization.

### 4.2 Logical memory revision

A revision contains only necessary fields: opaque record/revision ID; namespace and type; encrypted content reference; source/provenance; `FACT`, `INFERENCE`, or `HYPOTHESIS`; confidence/importance values with defined scales; transaction-time commit reference; valid-time interval; supersedes/retracts relation; Key Generation and format version; retention/policy labels. Direct identifiers and content-derived fingerprints do not belong in general event metadata.

### 4.3 Bitemporal rules

- `transaction_time` is authoritative Coordinator order/revision, not wall-clock time.
- `valid_time` describes when a claim applies in the modeled world.
- Finite validity intervals are half-open: `[valid_from, valid_until)`.
- `UNKNOWN`, `OPEN`, `UNBOUNDED`, and finite values are distinct typed states. Unknown boundaries are never guessed or normalized to infinity.
- Corrections append new events and retain provenance; no silent overwrite.
- Contradictory intervals are rejected or reviewed.

### 4.4 Historical interpretation

- **Knowledge-at-the-time:** only events committed by the queried transaction order are considered, with what the system knew then.
- **Best-current-historical-understanding:** current corrected knowledge is used for a historical valid-time question, while later provenance remains visible.

The query and answer must identify the selected interpretation. Later knowledge must not be represented as earlier knowledge.

### 4.5 Retrieval representation

Retrieval may combine lexical/semantic relevance, temporal validity, provenance, confidence, importance, task scope, and sourced explicit relationships. Weights and calibration remain open. No graph link is inferred from co-occurrence alone.

### 4.6 Historical Retrieval Evaluation Criteria

The historical initial acceptance criteria are restored without claiming they were tested or achieved:

- initial evaluation set: 100 questions;
- `Recall@5 >= 90%`;
- `Precision@5 >= 80%`;
- temporal accuracy `>= 95%`.

The exact original test-set specification and historical source are unavailable. These are evaluation targets, not a guarantee or result. The owner must approve the synthetic/test data, ground truth, scoring method, temporal interpretation rules, and whether the targets remain suitable before any future evaluation. Any change to these values requires explicit user approval; v3.6 does not substitute new values.

## 5. Event Journal and Ordering Authority

### 5.1 Memory Event Log decision

**Design definition:** Memory Event Log is a logical event-type partition within the canonical Coordinator Journal. It is not a second canonical event store and is not itself a projection. The physical storage layout remains unselected; no database or table technology is chosen here.

Each committed memory event is appended to the Coordinator Journal in the same transaction that allocates its `commit_sequence` and updates any Coordinator-owned state. An event is assigned its `commit_sequence` only at that durable commit. Current memory state, search indexes, graph indexes, embeddings, and caches are projections.

If a later deployment needs a physically separate read store, it may only be a derived projection fed from committed Coordinator Journal events. A separate canonical Memory Event Log would require a separately approved architecture; it cannot assign order or become another source of truth.

### 5.2 Event envelope and payload privacy

The canonical event envelope may contain event type/schema, random event ID, Coordinator Epoch, `commit_sequence`, Journal Revision, prior event reference/hash, non-personal state transition, and a one-time encrypted payload/binding reference where required. It must not contain a plaintext personal payload, public content hash, public content MAC, stable person/object key, or provider receipt content.

The Coordinator Journal integrity chain authenticates event order and non-personal envelope integrity. It is not a public fingerprint of personal content. Payload-binding commitments and content references are encrypted separately as described in Sections 6 and 10.

### 5.3 Ordering and append-only behavior

- `request_sequence` orders accepted requests at the Coordinator ingress queue; it does not prove a state transition.
- `commit_sequence` is monotonic and never reused; it is allocated in the same Coordinator transaction as the journal append.
- No subsystem assigns an independent committed order.
- The append-only journal records new authorization, correction, deletion, redaction, and recovery events. It does not promise that deleted content remains readable.

### 5.4 Projection consistency and reconstruction

Every derived projection row records its source event ID, source `commit_sequence`, and deterministic projection version/checkpoint. Projection application is idempotent by event ID and source sequence.

- Projection failure does not roll back a committed journal event; the projection is marked behind/unavailable and rebuilt from the journal.
- Missing events are found by replaying the journal after the projection watermark and comparing expected source sequence/event IDs and checkpoint hashes.
- Duplicate delivery of the same event ID and same committed sequence/hash is idempotently ignored.
- Duplicate IDs with different payload/envelope/hash, sequence collision, or impossible gaps are integrity errors and force `RECOVERY_REQUIRED`.
- After recovery, projections are rebuilt only from current authorized journal events after tombstones and key floors are applied.

### 5.5 Separate physical store, if later required

No separate canonical event store is selected in v3.6. If physical separation is proposed, a Coordinator transaction must first commit the canonical event plus a durable outbox entry. An asynchronous projector applies the outbox idempotently to the read store, records a checkpoint, and can replay after failure. The read store never acknowledges or assigns canonical order. No distributed transaction is assumed. This separation is a future design change requiring user approval and proof that deletion filtering is applied before visibility.

## 6. Cryptography, Protected Bindings and Generation Semantics

### 6.1 Envelope encryption

Personal content and staged payloads use per-object/per-operation DEKs wrapped under approved KEKs. Content encryption, payload-binding protection, Protected Link Store, and audit authentication use independent key domains. Key algorithms, sizes, cryptographic module, and custody are unselected BLOCKERS. No real key is created by this document.

### 6.2 AEAD, Nonce, and AAD

An approved AEAD must authenticate object/scope purpose, schema version, format, and Key Generation as AAD. Mutable AAD requires re-encryption. A `(key, nonce)` pair must never repeat. Retries reuse an already-created ciphertext rather than re-encrypting with the same nonce. Restore uncertainty invalidates the affected generation until nonce safety is established. Suite, nonce allocation, rotation, and rollback properties need approval.

### 6.3 Payload Binding Vault

A payload digest is sensitive metadata: a plain hash can permit equality tests or dictionary guessing, and a MAC can still be linkable if its key or input is reused. Therefore:

- The exact canonical payload bytes, destination, transformation, and policy are finalized before authorization.
- A fresh, random, per-operation binding key and random binding handle are used to create a domain-separated keyed commitment over the exact canonical payload and the required authorization attributes. The construction is a proposal; the cryptographic suite is not selected.
- The binding record (commitment, format, operation/grant mapping, destination/policy binding, key reference, and verification state) is encrypted in the Payload Binding Vault under an independent key domain with restricted Coordinator/Egress Gate access.
- The Coordinator verifies the commitment against the staged bytes before dispatch. It binds the authorization to a random one-time binding handle and committed grant. The public/canonical journal event contains no raw payload digest or content-derived MAC. The binding handle is encrypted in the event or represented only by a protected reference.
- A fresh per-operation key prevents deterministic cross-operation equality. Opaque handles alone are not treated as anonymization; timing, event order, ciphertext size, and external observations remain linkability risks.
- Adapter receipts that echo payload or content data are encrypted in Protected Receipt Store. The public audit event records only minimized result class and random receipt reference.

After a verified local deletion, the payload-binding record, operation key, staging key, and mapping needed to relate the binding to the person/object are destroyed or rendered cryptographically inaccessible under the approved erasure procedure. A retained journal order/MAC record can then prove that an authorized operation transition occurred, but cannot prove which personal bytes were authorized. This loss of content-specific audit verification is intentional and must be disclosed.

### 6.4 Audit integrity vs payload proof vs receipt proof

| Evidence plane | What it proves | Where it is stored / who can see it | What it does not prove |
|---|---|---|---|
| Journal integrity | Event ordering and integrity of the minimized control-plane envelope | Coordinator Journal; Witness receives only a system-level commitment | Personal content identity or external action |
| Operation authorization | Coordinator committed a scoped, policy-bound grant | Journal stores minimal grant state and a protected one-time binding reference; authorized Coordinator can verify | That Adapter was called or provider accepted it |
| Personal payload verification | Exact staged bytes matched the authorized per-operation commitment before dispatch | Encrypted Payload Binding Vault and Protected Egress Staging Store; restricted Coordinator/Egress Gate access | That bytes left device or reached provider |
| External receipt | Adapter/provider/receiver made the claim encoded in its authenticated receipt | Encrypted Protected Receipt Store; minimized status/reference in journal | More than the receipt contract, or end-user reading unless explicitly evidenced |

An Operation MAC is computed over a canonical, minimized control-plane audit record and protected reference, not a raw content digest or an unkeyed content hash. Its key is independent. A MAC proves integrity under the audit key, not provider truth.

### 6.5 Witness visibility and post-deletion remnants

Witness sees only the approved minimal system-level manifest: Coordinator identity/epoch, global Journal Revision/commit head, a system-level journal commitment, a global Deletion Revision, Witness request nonce/version, and freshness proof. It must not receive per-record payload digests/MACs, payload-binding handles, direct person/object IDs, destination, receipt body, or stable cross-operation links.

A journal root indirectly commits to journal contents and witness timing/sequence may expose activity patterns. This is not a claim of unlinkability. These residual signals require privacy measurement. After deletion, Witness may retain previously anchored global roots and aggregate revisions according to the future retention contract; it must not retain an explicit mapping to a deleted payload. The system cannot erase an already accepted witness root; it can destroy local binding/link keys and append a non-personal redaction/tombstone event.

### 6.6 Distinct generation/revision concepts

These values are not interchangeable. No backup may lower an independently authoritative value.

| Value | Owner | Source of truth | Increment rule | Becomes invalid when | Backup/restore rule |
|---|---|---|---|---|---|
| `Coordinator Epoch` | Coordinator leadership/failover authority | Durable Coordinator control metadata with journaled transition; exact HA authority is unselected | New exclusive Coordinator authority/term after old authority is fenced | A newer epoch is committed/recognized; old workers cannot refresh grants | Never accept lower epoch from backup; fetch current authority before admitting workers |
| `Fencing Generation` | Coordinator per scope | Committed Coordinator Journal event and Admission State projection | Increment on delete barrier, revocation, or other approved scope-wide invalidation | Any grant/worker with older generation is invalid | Rebuild from journal and current authority; never restore a lower generation |
| `Key Generation` | Key Generation Ledger | Key Store ledger reconciled to Witness anchor/floor | Increment on key rotation; deletion revokes/destroys targeted generations | Revoked/destroyed generations never become active again | Fetch newest witnessed floor before unwrap; backup cannot lower or reactivate |
| `Deletion Revision` | Coordinator Deletion Ledger | Committed deletion events; externally anchored revision for rollback protection | Advance on each committed deletion revision under an approved global or scoped policy | Superseded local view is stale; deletion itself is irreversible after anchor | Import latest witnessed revision; backup cannot erase an anchored tombstone |
| `Witness Revision` | Witness service | Witness's authenticated monotonic receipt/version | Witness-defined increment per accepted anchor | Older witness responses are stale | Never mint locally or restore from backup; query authenticated Witness |
| `Journal Revision` | Coordinator Journal format/manifest authority | Journal metadata and authenticated manifest | Advance when the journal format/manifest generation changes; event order remains `commit_sequence` | Unsupported or stale schema/manifest cannot be read as current without validated migration | Validate against current manifest/anchor; never infer or lower from snapshot |

The specific authorities and durability mechanisms are proposals and remain blockers until selected. `commit_sequence` orders events and is separate from all six values above.

## 7. Atomic Coordinator Admission and Dispatch Gates

### 7.1 One Coordinator arbitration authority

All admission, local-start, Adapter dispatch claim, delivery dispatch claim, delete barrier, fence generation, and operation-cancellation decisions for a scope pass through one durable Coordinator sequencer and Journal transaction. The exact database/consensus implementation is unselected. A local mutex alone is insufficient. The system must not assume a distributed atomic transaction with Witness or Adapter.

The transaction linearization point for a Coordinator state transition is its durable Journal commit that appends the event, allocates `commit_sequence`, updates Admission State, records operation state, and issues/revokes the grant atomically.

### 7.2 Four distinct send stages

1. **Authorization:** commit `SEND_AUTHORIZED` bound to final staged bytes, destination, policy, transformation, and private payload-binding handle.
2. **Local operation start:** commit `SEND_STARTED` after a worker acquires the operation. This proves only local start and does not permit direct Adapter access.
3. **Adapter invocation boundary:** the sole Egress Gate obtains the current serialized dispatch turn, validates the current fence and binding, and commits a single-use dispatch claim. While retaining the per-scope sequencer, it then enters the Adapter method and only afterward commits `ADAPTER_INVOCATION_OBSERVED`. The claim commit is the durable linearization point that wins dispatch-vs-delete ordering; the local method entry is the Adapter boundary; the observation-event commit records that entry after the fact. A delete barrier cannot commit between the ordered claim and local method entry in a healthy Gate. If the Gate crashes after the claim but before the observation event, entry cannot be proven or excluded and the result is `DISPATCH_BOUNDARY_UNKNOWN`. Even an observation event proves only local Adapter method entry, not network transmission.
4. **External result evidence:** validate an authenticated Adapter Receipt or explicit rejection and commit the result. A timeout/lost response may remain `SEND_OUTCOME_UNKNOWN`.

### 7.3 Delete vs dispatch serialization

A delete request immediately closes the local admission path and queues a barrier transaction. It competes for the same per-scope sequencer as a dispatch claim:

- If the delete barrier commits first, it increments Fencing Generation, revokes old grants, and prevents all later dispatch claims. A worker holding only `SEND_STARTED` cannot invoke the Adapter.
- If a dispatch claim is ordered first, the Egress Gate must enter the Adapter method before releasing the ordered gate to the delete transaction. Thus the invocation boundary precedes barrier commit. The provider may act later; the operation becomes in-flight and must be reconciled or recorded unknown.
- The system never waits for the full remote response while holding the per-scope dispatch gate. It releases after Adapter method entry, tracks in-flight operation independently, and then allows deletion barrier commit.
- A claim without proof of invocation or proof of non-invocation at crash/failover is boundary-ambiguous. It is never replayed. It is recorded as `DISPATCH_BOUNDARY_UNKNOWN`; external effect remains unknown unless authenticated evidence resolves it.
- Failover must prove the previous Gate/Coordinator epoch is fenced before a new Gate commits deletion or dispatch. If single-owner fencing cannot be proven, remain `RECOVERY_REQUIRED` and keep visibility and egress closed.

This orders the local Adapter invocation boundary against the delete commit; it is not an atomic transaction with the provider and cannot retract a prior call.

### 7.4 Mandatory scenario

Given:

1. `SEND_STARTED` is committed;
2. delete is requested;
3. `DELETE_REQUESTED` barrier and higher Fencing Generation commit;
4. the worker then tries to call the Adapter;

Result: the worker has no dispatch claim. The Gate rejects it because the barrier is active and its grant/fence is stale. If the Gate proves no dispatch claim/invocation occurred, record `SEND_CANCELLED_BEFORE_ADAPTER`. Do not call the Adapter, do not report send success, and do not classify it `SEND_OUTCOME_UNKNOWN` merely because `SEND_STARTED` existed. If a dispatch claim had already won before the barrier, the barrier must serialize after local Adapter entry or after a proven cancellation; if neither can be proven after a crash, record boundary/outcome uncertainty and fence the old worker. Never reuse that old grant.

### 7.5 Coordinator transaction scope and fencing

A Coordinator transaction covers only its own durable journal, sequence, operation state, admission projection, dispatch/cancellation decision, and generation update. Egress Gate invocation and provider effects are outside the database transaction. A single fenced Gate is required. Workers cannot call adapters directly, cache dispatch tokens, or bypass a current generation check.

A stale or split-brain Gate is a safety-critical failure. Lease expiry alone is not proof that the old process stopped. The deployment must provide a verifiable fencing mechanism (for example, an exclusive authority/epoch enforced by the Gate); no particular technology is selected. If stale Gate exclusion cannot be proven, the operation remains blocked and this is a BLOCKER.

## 8. Provider Send State Machine

### 8.1 State meanings

- `SEND_AUTHORIZED`: Coordinator committed a final-payload- and destination-bound grant.
- `SEND_STARTED`: local operation start is durably accepted; Adapter has not necessarily been called.
- `DISPATCH_CLAIMED`: serialized Gate accepted a single-use dispatch turn; by itself this is not proof that the Adapter method was entered.
- `ADAPTER_INVOCATION_OBSERVED`: local Gate recorded Adapter method entry; it does not prove request bytes left the device or reached the provider.
- `SEND_CONFIRMED`: an authenticated receipt supports the defined provider outcome.
- `SEND_REJECTED`: authenticated definitive provider rejection only.
- `SEND_CANCELLED_BEFORE_ADAPTER`: explicit cancellation proven before Adapter entry; this is not represented as a provider rejection.
- `DISPATCH_BOUNDARY_UNKNOWN`: crash/failover leaves uncertainty whether Adapter entry occurred after claim.
- `SEND_OUTCOME_UNKNOWN`: Adapter may have acted but no definitive external result evidence exists.

Unknown outcomes cannot be retried under the same operation. Human approval cannot convert uncertainty into evidence or authorize an automatic resend. A new send requires proof that the prior operation did not act or a separately approved duplicate-risk decision; such approval does not change the prior operation's unknown state.

### 8.2 Send transition table

| Previous state | Trigger | Preconditions / authority | Linearization and durable record | Next state | Failure behavior |
|---|---|---|---|---|---|
| `NONE` | authorize | Valid consent/policy; final immutable staged payload; destination; current scope fence; no delete barrier | Coordinator transaction commits `SEND_AUTHORIZED`, grant, and protected binding reference | `SEND_AUTHORIZED` | Deny; no Adapter call |
| `SEND_AUTHORIZED` | start local work | Grant current; idempotency binding matches | Coordinator transaction commits `SEND_STARTED` | `SEND_STARTED` | Recover by journal; no Adapter call on uncertain commit |
| `SEND_AUTHORIZED` | delete/revoke before local start | Barrier/revocation wins Coordinator ordering | Commit revocation; no worker lease | `SEND_CANCELLED_BEFORE_ADAPTER` | Gate remains closed |
| `SEND_STARTED` | request dispatch | Current Gate owns per-scope sequencer; fresh fence; digest verifies in vault; no barrier | Coordinator transaction commits single-use `DISPATCH_CLAIMED`; Gate enters Adapter under the held sequencer, then commits `ADAPTER_INVOCATION_OBSERVED` before releasing it | `ADAPTER_INVOCATION_OBSERVED` | If barrier wins first, `SEND_CANCELLED_BEFORE_ADAPTER`; if the post-entry commit is lost, boundary is unknown |
| `SEND_STARTED` | delete barrier commits before dispatch claim | Current fence advances; no invocation evidence | Commit barrier and cancellation of unclaimed start | `SEND_CANCELLED_BEFORE_ADAPTER` | If no reliable no-invocation proof, use `DISPATCH_BOUNDARY_UNKNOWN`, not cancellation |
| `DISPATCH_CLAIMED` | Gate proves Adapter not entered and releases claim | Authenticated local Gate outcome, same epoch, no possibility of escaped call | Commit `DISPATCH_NOT_ISSUED`; permit barrier/revocation | `SEND_CANCELLED_BEFORE_ADAPTER` or return to an explicitly authorized pre-start state | No retry without new grant; missing proof => boundary unknown |
| `DISPATCH_CLAIMED` | crash/failover before entry evidence | Claim durable; invocation could have occurred; old Gate must be fenced | Recovery records unresolved boundary; no second dispatch | `DISPATCH_BOUNDARY_UNKNOWN` | No automatic retry; deletion may continue local work after old Gate fencing |
| `ADAPTER_INVOCATION_OBSERVED` | authenticated positive receipt | Receipt authentic; operation and protected binding match; receipt semantics sufficient | Commit minimized status + protected receipt reference + Operation MAC | `SEND_CONFIRMED` | Invalid/missing receipt => unknown |
| `ADAPTER_INVOCATION_OBSERVED` | authenticated definitive rejection | Receipt is definitive for this operation | Commit status and protected receipt reference | `SEND_REJECTED` | Ambiguous response => unknown |
| `ADAPTER_INVOCATION_OBSERVED` | timeout, disconnect, lost reply, crash | No definitive receipt | Commit uncertainty when possible | `SEND_OUTCOME_UNKNOWN` | No automatic retry or success claim |
| `DISPATCH_BOUNDARY_UNKNOWN` / `SEND_OUTCOME_UNKNOWN` | reconcile | Authenticated provider query/receipt or other pre-approved reliable evidence | Commit evidence and classification | Confirmed/rejected/cancelled only if proven; otherwise remains unknown | No evidence means no state upgrade |
| Any operation | idempotency key reused with changed binding | Payload/destination/scope/policy mismatch | Commit `Idempotency Conflict` using minimized metadata | Original remains unchanged | Reject new operation |

### 8.3 Crash/interruption evidence for send

| Interruption point | What local evidence proves | What it cannot prove | Permitted action |
|---|---|---|---|
| After authorization, before `SEND_STARTED` | Grant exists in Coordinator | No worker activity unless independently logged | Revoke on delete; no call |
| After `SEND_STARTED`, before dispatch claim | Local work started | No Adapter invocation | Delete barrier cancels and fences; record cancel only if gate proves no claim |
| During claim before Adapter entry | Durable claim may exist | Without gate evidence, cannot know whether method entry occurred | Fence old Gate; mark boundary unknown; do not retry |
| After Adapter entry, before receipt | Local method entry occurred | Bytes on wire, provider receipt, or effect | External outcome unknown until evidence |
| After valid receipt commit | Receipt semantics only | Broader delivery/deletion at provider | Record exactly receipt-supported claim |

## 9. Result Delivery State Machine

Result Delivery applies the same two-stage local start / serialized Adapter invocation distinction as Provider Send. It uses a separate operation ID, authorization, payload binding, receiver, Gate, receipt, and audit key.

### 9.1 Delivery states

`DELIVERY_AUTHORIZED`, `DELIVERY_STARTED` (local only), `DELIVERY_DISPATCH_CLAIMED`, `DELIVERY_ADAPTER_INVOCATION_OBSERVED`, `HANDOFF_CONFIRMED`, `DELIVERY_REJECTED`, `DELIVERY_CANCELLED_BEFORE_ADAPTER`, `DELIVERY_DISPATCH_BOUNDARY_UNKNOWN`, and `DELIVERY_OUTCOME_UNKNOWN`.

`HANDOFF_CONFIRMED` means only the receipt-defined handoff. It does not prove a human read the result unless the receiver contract establishes that fact.

### 9.2 Delivery transition table

| Previous state | Trigger | Preconditions / authority | Linearization and durable record | Next state | Failure behavior |
|---|---|---|---|---|---|
| `NONE` | authorize delivery | Result finalized; consent/policy and immutable payload/receiver bound; no barrier | Coordinator transaction commits `DELIVERY_AUTHORIZED` and protected binding | `DELIVERY_AUTHORIZED` | No delivery call |
| `DELIVERY_AUTHORIZED` | start local work | Grant, binding, and fence valid | Coordinator transaction commits `DELIVERY_STARTED` | `DELIVERY_STARTED` | No delivery call if commit uncertain |
| `DELIVERY_STARTED` | dispatch claim | Delivery Gate owns sequencer; current fence; payload verifies; no barrier | Commit single-use claim; Gate enters receiver Adapter under the held sequencer, then commits `DELIVERY_ADAPTER_INVOCATION_OBSERVED` before release | `DELIVERY_ADAPTER_INVOCATION_OBSERVED` | If barrier wins first, cancel before Adapter; lost post-entry commit means boundary unknown |
| `DELIVERY_STARTED` | delete barrier wins before claim | No claim/invocation; fence increments | Commit barrier and proven cancellation | `DELIVERY_CANCELLED_BEFORE_ADAPTER` | Ambiguous claim => boundary unknown |
| `DELIVERY_DISPATCH_CLAIMED` | proven not issued | Authenticated Gate evidence | Commit `DELIVERY_NOT_ISSUED` | `DELIVERY_CANCELLED_BEFORE_ADAPTER` | No proof => boundary unknown |
| `DELIVERY_DISPATCH_CLAIMED` | crash/failover | Could have crossed invocation boundary | Commit recovery uncertainty; fence old Gate | `DELIVERY_DISPATCH_BOUNDARY_UNKNOWN` | No retry |
| `DELIVERY_ADAPTER_INVOCATION_OBSERVED` | valid handoff receipt | Receipt binds operation/binding/receiver and defined semantics | Commit minimized receipt status/reference and Operation MAC | `HANDOFF_CONFIRMED` | Invalid or absent receipt => unknown |
| `DELIVERY_ADAPTER_INVOCATION_OBSERVED` | definitive rejection | Authenticated explicit receiver/adapter rejection | Commit rejection evidence reference | `DELIVERY_REJECTED` | Ambiguity => unknown |
| `DELIVERY_ADAPTER_INVOCATION_OBSERVED` | timeout/crash/lost reply | No definitive receipt | Commit uncertainty when possible | `DELIVERY_OUTCOME_UNKNOWN` | No automatic retry/success |
| Unknown delivery state | reconcile | Authenticated receiver evidence | Commit evidence | Confirmed/rejected only if proven; otherwise unknown | Never infer human receipt |
| Any | idempotency conflict | Different result/receiver/policy binding | Commit conflict record | Original unchanged | Reject |

### 9.3 Delete race for Result Delivery

The Delivery Gate and deletion barrier use the same per-scope serialized ordering rule as Section 7. A barrier committed first denies old delivery authorization and fences stale workers. If the delivery invocation boundary wins first, the operation is in-flight and may have reached the receiver; deletion cannot retract it and records the receipt-supported or unknown result separately.

## 10. Authorization and Payload Binding

### 10.1 Authorization object

A grant binds an opaque one-time operation/scope, action, destination/receiver, canonical payload binding handle, content/transformation version, policy and consent revision, Coordinator Epoch, Fencing Generation, committed sequence, idempotency key digest, and applicable key/deletion/witness constraints. The actual digest/commitment is not exposed in ordinary audit or witness records.

Any byte, destination, transformation, policy, scope, or receiver change invalidates the grant and requires a new authorization.

### 10.2 Final payload and proof

1. Minimize and finalize exact payload bytes and destination.
2. Canonicalize using a versioned method; stage encrypted bytes.
3. Create per-operation protected binding commitment and random handle.
4. Coordinator verifies the commitment before committing authorization.
5. At dispatch, the sole Gate re-reads the exact staged bytes, re-verifies the protected commitment and current policy/fence, then enters the Adapter only under the serialized dispatch permit.
6. Store the Adapter receipt in the Protected Receipt Store; journal only minimized result and opaque reference.

This proves locally that the staged bytes matched the payload approved by the Coordinator at verification time. It does not prove bytes left the device or were received externally.

### 10.3 Retention and deletion of binding proof

The Payload Binding Vault is separately encrypted and access-restricted. It uses a distinct per-operation key domain, never the content key or audit MAC key. On deletion, destroy the per-operation binding key and remove/revoke the binding-to-person/object association after tombstone anchor and key-destruction order. Append a minimized redaction event rather than rewriting the journal. Ciphertext or random one-time references may remain in immutable logs/backups; without the mapping/key they should not disclose the payload, but linkability is not presumed impossible and remains a privacy risk to measure.

After binding-key erasure, later auditors can verify the retained control-plane event and its ordering but cannot re-verify the personal payload bytes. This trade-off is explicit, not concealed as a complete audit proof.

## 11. Witness and Anchor Protocol

### 11.1 Witness manifest

Witness receives only a system-level manifest with Coordinator Epoch, Journal Revision, `commit_sequence` head, a minimized global journal commitment, global Deletion Revision, a random anchor operation nonce, format version, and witness freshness/monotonic response. It receives no payload digest/MAC, binding handle, stable person/object ID, destination, or receipt content.

The global root, event cadence, sequence movement, deletion revision, anchor timing, and ciphertext sizes may still leak correlations. Opaque identifiers do not by themselves establish unlinkability. Privacy evaluation remains required.

### 11.2 Anchor lifecycle and states

1. Coordinator commits an event locally; it is in `UNANCHORED_REGION` until proof is verified.
2. Anchor operation gets a stable random `anchor_operation_id` and idempotency key bound to one exact manifest digest.
3. Coordinator sends only the approved manifest to Witness.
4. Witness acceptance must be authenticated and bind the same operation ID, manifest, and monotonic Witness Revision.
5. Coordinator verifies response and commits the receipt reference; covered events enter `ANCHORED_REGION`.
6. A crash or lost response causes an exact status query/reconciliation for that same operation ID and manifest. It never creates a second logical tombstone/anchor operation to guess the first result.

### 11.3 Witness ambiguity and recovery cases

| Case | Required action | Forbidden action |
|---|---|---|
| Witness unavailable before request | Keep region unanchored; safety-critical deletion/restore stays blocked | Claim anchor or destroy deletion keys |
| Request sent, response lost | Query by same `anchor_operation_id`; retry only the exact idempotent request if the future Witness contract guarantees it | Create a fresh operation ID/manifest blindly |
| Witness accepted, Coordinator crashed | Query authenticated status for same operation/manifest, then commit exact receipt | Assume rejection or mint contradictory anchor |
| Coordinator restart | Read Journal and pending anchor operation; query Witness | Use local `anchored=true` bit alone |
| Matching prior tombstone exists | Verify operation ID, deletion revision, manifest commitment, Witness Revision and scope proof | Create another tombstone for same logical delete |
| Tombstone/manifest differs | `RECOVERY_REQUIRED`; retain gate closed and investigate integrity | Overwrite the prior tombstone or accept different content under same ID |
| Only old anchor available | Treat newer local state as unanchored; obtain current witness state | Treat old anchor as proof of latest deletion |
| Protected Link Store missing | No guessed scope mapping; quarantine unresolved delete | Reconstruct by similarity/timing |

The Witness idempotency, status-query, consistency, and finality guarantees are not claimed until its technical contract is selected and reviewed.

## 12. Witness-First Deletion and Separate Outcomes

### 12.1 Deletion status dimensions

A single `DELETION_COMPLETED` status is ambiguous and is not emitted by v3.6. Track independently:

- `LOCAL_BLOCKED`: Visibility Gate closed, admission fenced, contexts/caches/leases revoked locally.
- `TOMBSTONE_ANCHORED`: opaque delete intent durably acknowledged by the verified Witness.
- `LOCAL_KEYS_ERASED`: specified local data-key generations destroyed/revoked and verified under the key contract.
- `LOCAL_ARTIFACTS_CLEANED`: locally controlled content blobs, projections, indexes, caches, temporary files, and staged payload copies cleaned or cryptographically inaccessible with an inventory result.
- `LOCAL_BACKUP_POLICY_APPLIED`: restore guard/tombstone is guaranteed to apply before visibility and retention/expiry policy is applied. This does not claim old backup bytes have physically disappeared.
- `LOCAL_DELETION_COMPLETED`: all applicable local phases above are verified. It says nothing about external provider deletion.
- `EXTERNAL_EFFECT_NONE_PROVEN`: reliable gate/journal evidence proves the Adapter was never entered.
- `EXTERNAL_EFFECT_CONFIRMED` / `EXTERNAL_EFFECT_REJECTED`: authenticated receipt supports that classification.
- `EXTERNAL_EFFECT_UNKNOWN`: a call may have reached or affected the provider/receiver, but no definitive outcome is available. It may remain unknown permanently.
- `PROVIDER_DELETION_NOT_REQUESTED`, `PROVIDER_DELETION_UNSUPPORTED`, `PROVIDER_DELETION_REQUESTED`, `PROVIDER_DELETION_CONFIRMED`, or `PROVIDER_DELETION_UNKNOWN`: independently tracks remote deletion only if requested and supported.

No status may imply that provider-retained data was erased unless the provider's contract and authenticated evidence establish that exact claim.

### 12.2 Local deletion transition table

| Previous state | Trigger | Preconditions / authority | Durable evidence | Next state | Failure behavior |
|---|---|---|---|---|---|
| `LOCAL_ACTIVE` | Delete requested | Authorized request; exact scope resolved using current Protected Link Store | Coordinator commits `DELETE_REQUESTED`, barrier, Fencing Generation increment, local gate close | `LOCAL_BLOCKED` | On ambiguous commit, gate remains closed and recovery reads journal |
| `LOCAL_BLOCKED` | Build deletion manifest | Authenticated exact mappings; no heuristic expansion | Commit deletion operation/revision and inventory commitment | `LOCAL_MANIFEST_PREPARED` | Missing link evidence => `RECOVERY_REQUIRED`, no guessed delete |
| `LOCAL_MANIFEST_PREPARED` | Anchor tombstone | Stable idempotent tombstone operation ID and exact manifest | Authenticated Witness receipt for same operation/revision | `TOMBSTONE_ANCHORED` | Unknown Witness result => query same ID; do not destroy keys |
| `TOMBSTONE_ANCHORED` | Destroy local keys | Current witnessed tombstone and exact key generations | Key store destruction/revocation evidence + updated irreversible floor | `LOCAL_KEYS_ERASED` | Partial failure remains pending; never restore keys |
| `LOCAL_KEYS_ERASED` | Clean local artifacts | Complete artifact inventory and cleanup manifest | Per-class cleanup/invalidation evidence | `LOCAL_ARTIFACTS_CLEANED` | Unverified item remains pending/recovery |
| `LOCAL_ARTIFACTS_CLEANED` | Apply backup policy | Restore guard references current tombstone/key floor; retention/expiry rule approved | Backup inventory and restore-guard evidence | `LOCAL_BACKUP_POLICY_APPLIED` | No verified guard => no local completion |
| `LOCAL_BACKUP_POLICY_APPLIED` | Close local deletion | Journal, tombstone, keys, cleanup and backup guard reconcile | Commit local completion event, no personal payload digest | `LOCAL_DELETION_COMPLETED` | Any missing proof => remain incomplete/recovery |

### 12.3 External operation and provider deletion outcomes

Deletion does not erase a Provider's copy by implication. Each pre-barrier send/delivery operation is reconciled as none-proven, confirmed, rejected, or unknown. A distinct provider-side deletion request may be issued only under an approved contract and its own authorization, payload/privacy review, idempotency, and evidence. `PROVIDER_DELETION_CONFIRMED` requires authenticated provider evidence whose stated meaning includes deletion of the relevant provider-held data. A receipt that only confirms request acceptance is not deletion proof.

If an external operation remains permanently unknown, it stays `EXTERNAL_EFFECT_UNKNOWN`. The system may still record `LOCAL_DELETION_COMPLETED` after every local requirement is proven, while presenting the unresolved external state and risk separately. It must not emit a generic all-scope `DELETION_COMPLETED` claim.

### 12.4 Ordering and deletion invariants

1. Commit local barrier and Fencing Generation increment.
2. Revoke local permissions, contexts, caches, leases, and unclaimed operations; reconcile dispatch claims under Sections 7-9.
3. Resolve exact artifact set and prepare stable, opaque, idempotent tombstone operation.
4. Anchor tombstone before destroying affected data keys.
5. Destroy/revoke local keys; clean local content, projections, caches, indexes, staging, and temporary copies.
6. Apply backup tombstone/restore guard and approved retention policy.
7. Record local completion only for proved local effects; report remote operation/deletion states separately.

After tombstone anchor, deletion only proceeds forward. If witness confirmation is unknown, no data keys are destroyed. A local delete request immediately blocks local visibility but is not externally rollback-resistant until anchor proof.

## 13. Tombstone and Protected Link Store

### 13.1 Idempotent opaque tombstone

Every logical deletion has one stable random `tombstone_operation_id`, an idempotency key, a fixed canonical manifest commitment, and a Deletion Revision. Retry must use the exact same operation ID and manifest. Witness response is queried by that ID. A matching prior tombstone can be resumed; a differing revision/manifest is a consistency failure and `RECOVERY_REQUIRED`.

Tombstones contain no plaintext memory, name, key, content digest/MAC, provider payload, or stable person identifier. The tombstone can still be linkable through cadence, counts, or revisions; opacity is not a privacy proof.

### 13.2 Protected Link Store loss

If the store is absent, corrupt, stale, or cannot authenticate, keep the affected Visibility Gate closed, preserve deletion as unresolved, and recover only from a separately authenticated current backup or approved independent mapping. Never infer links from semantic similarity, neighboring tombstones, IDs, timing, or content.

### 13.3 Append-only history and deletion

The Coordinator Journal is append-only for control-plane events. Personal content resides in separately encrypted content/binding stores, not as plaintext inside permanent journal records. Deletion therefore:

- retains minimal non-personal ordering evidence and the fact that a redaction/deletion transition occurred;
- destroys content DEKs and payload-binding keys/associations after the required Witness anchor;
- purges or invalidates local content and derived projections under the verified inventory;
- appends a minimized `CONTENT_REDACTED`/deletion event rather than rewriting prior sequence history;
- may leave ciphertext, random references, journal roots, or backup bytes physically present. Without the destroyed keys those bytes are intended to be inaccessible, but residual metadata/linkability and physical erasure are not claimed without evidence.

An append-only audit record must not retain a personal identifier or content-derived digest merely to make post-deletion content verification possible. Post-erasure verification proves key/artifact procedure and event order, not original personal bytes.

## 14. Rollback, Backup Restore and Recovery

### 14.1 Restore gate

A restored image starts quarantined: Visibility Gate closed, no key unwrap, memory retrieval, Adapter invocation, or result delivery. A local backup never overrides a newer current Witness Revision, Deletion Revision, Key Generation floor, Coordinator Epoch, or Fencing Generation.

### 14.2 Deterministic recovery order

| Order | Object | Source of truth | Recovery action |
|---:|---|---|---|
| 1 | Visibility Gate / Adapter access | Closed-by-default process state + current Coordinator | Close and disable release before inspecting restored state |
| 2 | Coordinator Epoch | Current exclusive Coordinator authority | Fence old workers; if authority cannot be proven, remain blocked |
| 3 | Coordinator Journal / Journal Revision / commit head | Integrity-checked journal or authenticated current replica | Verify chain and sequence; witness hash cannot reconstruct missing entries |
| 4 | Witness Revision and manifest | Authenticated current Witness response | Query current head/floor; reject stale local anchor claims |
| 5 | Tombstones / Deletion Revision | Witness-anchored tombstone and deletion ledger | Import newer tombstones; never erase from backup |
| 6 | Key Generations | Key ledger reconciled to witnessed floor | Refuse old/revoked generations before unwrap |
| 7 | Protected Link Store | Authenticated latest revision | Use exact mappings only; loss means unresolved recovery |
| 8 | Admission State / Fencing Generation | Rebuilt from latest committed journal and Coordinator authority | Ignore snapshot projection; apply barrier and fresh fence |
| 9 | Pending send/delivery operations | Journal + authenticated protected receipts | Resolve by evidence; preserve unknowns; no retry |
| 10 | Backups and artifacts | Snapshot manifest, current tombstone, key floor, retention policy | Reject stale image or apply tombstone before any reads |
| 11 | Projections/indexes/caches/staging | Replay of current surviving journal events | Rebuild and verify deletion filters before visibility |
| 12 | Gate reopening | All above proofs + approved RPO policy | Commit recovery completion and new fence; open only proven-safe scope |

A missing or conflicting source, stale witness, unknown key floor, lost link map, unresolved dispatch authority, or unavailable current journal means `RECOVERY_REQUIRED`. No direct transition from that state to normal operation is permitted.

### 14.3 Crash matrix

| Crash point | Durable/local evidence | Recovery result |
|---|---|---|
| Before Coordinator commit | No committed transition | Re-read journal and deduplicate by operation ID |
| After `SEND_STARTED`, no dispatch claim | Local start only | Cancel after delete if Gate proves no claim; never infer Adapter entry |
| After dispatch claim, before observed entry | Claim could be between stages | Fence old Gate; boundary unknown unless authenticated no-entry evidence exists; never replay |
| After Adapter method entry, before receipt | Local Adapter entry | External effect unknown absent valid receipt/query |
| Delete barrier committed | Barrier and higher fence | Old worker/grant denied; already-entered operation remains in-flight/unknown |
| Witness accepted, reply lost | Request ID and manifest known | Query same operation ID; do not create conflicting anchor |
| Tombstone anchored, before key destruction | Irreversible delete intent | Continue forward; never reopen visibility/restore key |
| During local cleanup | Cleanup evidence incomplete | Keep local deletion pending; rerun idempotent cleanup and verify |
| Old backup restore | Local state may predate delete | Quarantine; fetch witness/tombstone/key floors before reads |

## 15. RPO and Witness Policy

No RPO or cadence value is invented. The following remain approval blockers before Phase B:

- maximum recoverable event loss/RPO;
- maximum number of events in `UNANCHORED_REGION`;
- maximum time between Anchors under a trusted-time definition;
- Witness outage and queue/block policy;
- accepted quorum/finality and status-query semantics;
- re-entry conditions after outage;
- authoritative journal replica if a restored journal is behind the Witness.

Until values and contracts are approved, no RPO guarantee is claimed; safety-critical deletion, restore, key release, and visibility fail closed if Witness proof is absent or stale. A hash-only Witness anchor cannot reconstruct missing journal entries.

## 16. Metadata Privacy Threat Model

### 16.1 Adversaries

Assess local backup/log observers without keys, cloud/provider observers of destination/timing/size, Witness operators observing anchor revisions/cadence, cross-source analysts with auxiliary timestamps, restore attackers comparing images, limited insiders, and compromise of a single key domain. Collusion, duration, and auxiliary data assumptions need approval.

### 16.2 Metadata risks

Potentially linkable metadata includes timestamps and order, sequence gaps, event types/counts, payload/ciphertext sizes, stable IDs, keyed or plain payload digests/MACs, receipt contents, destination/provider, witness cadence, tombstone counts, key/deletion revisions, graph edges, cache/index deltas, and cleanup timing. A keyed digest can still be linkable if key/input is reused; an opaque ID does not itself anonymize.

### 16.3 Baseline

Before measurement, define every stored/transmitted field, purpose, audience, key domain, precision, and retention. Forbid direct identifiers and public personal-content hashes/MACs by default. Use operation-specific randomized protected binding; minimize event and witness visibility; identify residual global roots/timing/count leakage. Exceptions require a documented need, owner approval, and retention period.

## 17. Privacy Measurement and Acceptance

No privacy result is asserted. Before any future test, approve the attacker model, baseline, synthetic data, procedure, confidence, acceptance thresholds, and reproducibility. Metrics include re-identification, linkage precision/recall, tuple uniqueness, event/delete timing inference, cross-journal/Witness/provider/backup linkage, and residual post-deletion recovery.

The historical criteria in this section are evaluation targets; they are not results. Values may not be changed without approval:

| Evaluation | Historical target | Status |
|---|---|---|
| Initial retrieval question set | 100 questions | Future test design; original source/test set unavailable |
| Recall | `Recall@5 >= 90%` | Not tested / not achieved claim |
| Precision | `Precision@5 >= 80%` | Not tested / not achieved claim |
| Temporal accuracy | `>= 95%` | Not tested / not achieved claim |
| Metadata privacy | Owner-approved metric-specific thresholds, sample size, confidence and attack procedure | Values unavailable; BLOCKER |

Use synthetic data only in the currently unauthorized phases. The retrieved historical 100-question target does not define whether that set is the complete benchmark or an initial slice; confirm with user before test planning. `N`, confidence `C`, and privacy acceptance thresholds `T_i` remain decisions, not values to invent.

## 18. Memory Retrieval and Context Building

1. Classify task, authorization, sensitivity, and local-only policy.
2. Query only required STM/WM/LTM/KB namespaces; never merge by default.
3. Filter deleted, expired, unauthorized, invalid-time, sensitive, or wrong-scope records before ranking.
4. Rank by task relevance, explicit sourced relations, valid time, provenance, confidence, and importance; scoring weights remain uncalibrated until approved.
5. Enforce per-task count/token budget and deduplication.
6. Include provenance, epistemic label, and requested time interpretation.
7. Treat retrieved memory as data, not instructions; abstain where evidence is insufficient.
8. Do not send full memory; cloud context needs separate policy and payload-bound authorization.

### 18.1 Evaluation protocol requirements

Future Retrieval Evaluation uses the historical initial set of 100 questions and metrics in Section 17, with a frozen answer key, temporal ground truth, relevance judgments, task categories, and independent scoring. Any representative/synthetic dataset construction and benchmark changes require approval. No execution is authorized here.

## 19. Sleep-time Consolidation

Sleep-time consolidation is a resumable local proposal/review process, never an automatic confirmed-memory rewrite.

- Persist a job ID, source journal range/hash, algorithm/prompt version, privacy policy, checkpoint, and status.
- Process bounded eligible local data; no implicit remote call.
- Checkpoint batches with source commit range and deterministic output digest.
- Create proposals with evidence, provenance, uncertainty, temporal scope, and explanation.
- Keep proposals out of current confirmed projection until explicit review and a new committed event.
- On resume, validate source range, tombstones, keys, job version, and checkpoint. Recompute/discard stale output.
- Deletion cancels/removes affected proposals and temporary context; no processing past a barrier.

## 20. Experience Learning and Skills Versioning

Skills are immutable, versioned proposals until evaluation and human approval. Capture lineage, training examples, independent test cases, environment/tool versions, evaluator evidence, permissions, and rollback target. Rollback changes the approved active pointer; it does not rewrite history or restore deleted keys/data.

### 20.1 Historical low-risk skill acceptance criteria

For tasks explicitly classified **low-risk**, preserve the previously supplied criteria:

- at least five independent trials;
- success rate at least 90%;
- independent evaluation examples not used for training;
- no critical failure;
- human review before version approval;
- explicit rollback criteria to a previously approved version.

These are not universal guarantees for all skills. The five-trial minimum and 90% empirical threshold do not establish statistical confidence; with exactly five trials, the measured outcomes must be interpreted as a small sample. High-risk tasks, exceptions, failure severity definitions, and any changed threshold require explicit user approval. The criteria are not tested or achieved.

### 20.2 Rollback evidence

Before release, define the prior approved version, activation pointer, compatibility/data dependencies, rollback trigger, and evidence that rollback does not reactivate revoked keys or deleted source data. Rollback is a new auditable pointer event, not restoration of old authority.

## 21. Local/Cloud Privacy Routing

- Sensitive data or classification uncertainty is local-only or blocked; no cloud fallback.
- Retrieve/minimize context before routing; authorize exact provider/destination/data categories.
- Bind the exact final payload through Payload Binding Vault and Sections 7-10.
- Treat prompt, response, routing metadata, timing, size, destination, and provider receipts as privacy-sensitive.
- Send and result delivery require independent approvals and operation evidence.
- No secrets or unapproved memories go to a provider.
- Unknown outcomes are not retried automatically.
- Provider retention, training use, residency, deletion APIs, receipt semantics, and contract guarantees are BLOCKERS before external memory use.

## 22. Failure and Recovery Matrices

### 22.1 Send/delete race outcomes

| Race order / failure | Evidence | Exact outcome | Delete effect |
|---|---|---|---|
| Delete barrier commits before `SEND_AUTHORIZED` | Journal order | Authorization denied | Gate closed |
| Authorization commits, delete commits before `SEND_STARTED` | No local start or dispatch claim | Revoke grant; `SEND_CANCELLED_BEFORE_ADAPTER` if Gate proves no entry | Local deletion proceeds |
| `SEND_STARTED` commits, delete commits before dispatch claim | Local start only; no claim | Fence old worker; prove no claim and cancel. `SEND_STARTED` is not unknown by itself | Local deletion proceeds |
| Dispatch request and delete race; delete linearizes first | Barrier commit precedes claim | Gate rejects stale grant; no Adapter invocation | Local deletion proceeds |
| Dispatch claim linearizes first in healthy Gate | Gate serializes entry before barrier commit | Adapter method was entered locally; external effect still unproven | Delete commits after entry and tracks in-flight effect |
| Claim committed, Gate crashes before invocation evidence | Durable claim, absent proof of entry/non-entry | Fence old Gate; `DISPATCH_BOUNDARY_UNKNOWN`; never replay | Local deletion can proceed after old Gate fencing; report external uncertainty |
| Adapter entry occurs before barrier; reply lost | Local entry, no receipt | `SEND_OUTCOME_UNKNOWN` | Local deletion may complete independently; external risk remains disclosed |
| Authenticated receipt before/after barrier | Valid receipt bound to operation | Confirm only receipt-supported outcome | Does not prove provider-side deletion |
| Old worker tries Adapter after barrier | Stale Fencing Generation/Epoch | Gate rejects; no adapter invocation | Barrier remains effective |

Same ordering and evidence classifications apply to `DELIVERY_STARTED` and Delivery Gate; use delivery state names and receiver receipt semantics.

### 22.2 Witness and tombstone

| Condition | Required state/action | Prohibited result |
|---|---|---|
| Witness unavailable before anchor | Keep tombstone pending; no key destruction | No anchor/deletion-complete claim |
| Anchor accepted, reply lost | Query exact stable operation ID/manifest; retry only under approved idempotency contract | No new conflicting tombstone |
| Coordinator restart with pending anchor | Re-read journal, query Witness, reconcile exact receipt | No local `anchored` inference |
| Matching prior tombstone | Verify exact operation/revision/manifest then resume | No duplicate logical deletion |
| Manifest mismatch or old anchor only | `RECOVERY_REQUIRED`, gate closed | No overwrite or stale-anchor acceptance |
| Link store lost | Preserve unresolved deletion, no guessed links | No inferred scope completion |

### 22.3 Restore and visibility

| Failure | Required action | Gate/key rule |
|---|---|---|
| Witness unavailable/stale | `RECOVERY_REQUIRED` | No visibility or key unwrap |
| Journal behind Witness | Fetch authenticated current journal replica | Hash cannot reconstruct events |
| Tombstone/key floor newer than backup | Import latest anchored floors first | Never revive old generation |
| Projection incomplete/duplicate conflict | Rebuild by event ID/commit sequence; conflict requires recovery | No stale projection visible |
| Coordinator Epoch/fence uncertain | Fence old authority or halt | No adapter invocation |
| Trusted time unavailable | Disable time-dependent lease decisions | Do not extend stale grants |
| External outcome permanently unknown | Preserve `*_OUTCOME_UNKNOWN` | No remote success/deletion claim |

## 23. Vertical Slice (Future Design/Test Scope Only)

The following previously specified small vertical slice is restored as a future design and test scope, not authorization to implement or execute it:

- one synthetic Claim;
- one Source;
- record the event in the canonical Coordinator Journal / Memory Event Log logical partition;
- enforce scoped permissions;
- append a correction and preserve prior history;
- query current state and both historical interpretation modes;
- prove transaction/commit-sequence behavior;
- rebuild the current projection from the event journal;
- execute a synthetic deletion test that exercises barrier, tombstone, key-generation floor, local cleanup, backup restore gate, and reporting of external status.

No real/personal content, actual encryption/deletion, live provider, or database migration is in scope. Test data, exact test oracle, and authorization remain future approvals. The slice has not been implemented or tested.

## 24. Guarantees, Assumptions and Open Decisions

### 24.1 Preserved design requirements

- one Coordinator committed-order source and monotonic non-reused commit sequence;
- request and commit sequence distinct;
- Memory Event Log is not a competing order source;
- fencing prevents old workers from using grants after barrier commit, subject to proof of single Gate/failover exclusion;
- separate send and delivery state machines and authorizations;
- local `STARTED` is not proof of Adapter entry or external outcome;
- unknown outcome does not become automatic retry/success;
- payload-specific verification is protected and separated from journal/Witness metadata;
- witness-first deletion, key generation non-revival, opaque idempotent tombstones;
- local completion and external effects/deletion are reported independently;
- loss of Protected Link Store never triggers guessed mappings;
- restore gate remains closed until journal, witness, tombstone, key, link, pending-operation, and projection checks pass;
- memory model, temporal semantics, provenance, bounded retrieval, review-only consolidation, and evaluated reversible skills remain required.

These are specifications, not demonstrated guarantees.

### 24.2 Assumptions

- A single durable Coordinator sequencer can serialize both dispatch claims and delete barriers.
- A sole Egress/Delivery Gate can enforce current fencing at the Adapter invocation boundary.
- Gate failover can prove old Gate exclusion; lease timeout alone is insufficient.
- Coordinator storage can atomically commit journal/order/projection/operation state.
- Witness can provide authenticated status queries and stable idempotent operation results.
- Key store can irreversibly destroy binding/content keys and prevent backup revival.
- Provider/receiver offers authenticated receipts adequate for their defined claims.
- Complete artifact and backup inventories are possible.

No assumption is considered proof until independently reviewed.

### 24.3 Open decisions and blockers

- Physical Coordinator storage and HA/consensus/leader-fencing mechanism.
- Whether one Gate can serialize all dispatch/delete operations per scope and exact crash/failover protocol.
- Witness vendor/contract, idempotency, consistency, freshness, retention, and status-query semantics.
- RPO, maximum unanchored event count, anchor interval, outage and re-entry policies.
- Cryptographic suite, per-operation binding key creation/destruction, nonce strategy, key custody, and erasure evidence.
- Exact payload-binding/audit retention and acceptable loss of content verification after deletion.
- Provider and receiver receipt semantics, lookup/reconciliation, external deletion evidence, and unknown-outcome policy.
- Backup expiry, physical erasure, restore source, and retention exceptions.
- Retrieval benchmark definition/100-question set suitability and ground truth.
- Low-risk task taxonomy, critical failure definition, skill evaluation scope and any exceptions.
- Metadata threat model, sample size, confidence, thresholds, and privacy test procedure.
- Confidence/importance scales, relation scoring, time serialization, consent and cloud policies.

## 25. Implementation Blockers and Readiness Gates

No implementation or phase is authorized. At minimum:

- **BLOCKER-01 History:** original v1.0-v3.3 documents/revision evidence unavailable; exact first version of most decisions cannot be authenticated.
- **BLOCKER-02 Dispatch/delete serialization:** prove the one sequencer orders `DISPATCH_CLAIMED` and barrier commit; define the exact Adapter-entry interlock.
- **BLOCKER-03 Gate failover:** prove a stale or partitioned Egress/Delivery Gate cannot invoke an Adapter after a newer barrier/epoch. If unprovable, remain blocked.
- **BLOCKER-04 Boundary crash:** define evidence for `DISPATCH_NOT_ISSUED` versus `DISPATCH_BOUNDARY_UNKNOWN`; never infer from absence of response.
- **BLOCKER-05 Coordinator storage:** select and prove transaction durability and commit-sequence non-reuse; no technology is selected.
- **BLOCKER-06 Witness contract:** select trust, operation idempotency, query/reconciliation, monotonicity, retention, and outage behavior.
- **BLOCKER-07 RPO:** owner must approve RPO, maximum unanchored events, anchor interval, outage, and re-entry values.
- **BLOCKER-08 Payload binding privacy:** approve crypto construction, key custody/destruction, vault access, audit retention, and metadata threat assessment.
- **BLOCKER-09 Deletion evidence:** define local cleanup inventory, backup policy, external deletion contract, and unresolved external-risk presentation.
- **BLOCKER-10 Generation/epoch authorities:** implement and independently verify the six separate monotonic values and restore floors.
- **BLOCKER-11 Memory Event Log:** approve physical storage and transaction design while retaining one canonical Coordinator order.
- **BLOCKER-12 Historical Retrieval criteria:** confirm the initial 100-question set and targets before any evaluation; no result exists.
- **BLOCKER-13 Historical Skill criteria:** approve low-risk taxonomy, critical failure rules, independent trials, reviewer and rollback rules; no result exists.
- **BLOCKER-14 Privacy measurement:** approve adversary, baseline, synthetic dataset, sample size, confidence, acceptance limits, and repeatability.
- **BLOCKER-15 Recovery/backup source:** provide a current authenticated journal source and prove all tombstones/key floors apply before visibility.
- **BLOCKER-16 Independent review:** security, privacy, cryptographic, storage, state-machine, and operational recovery reviews remain required.

Gate 0 (document review) is current. Gates for implementation, Phase A, and Phase B require separate approvals and remain NOT AUTHORIZED/BLOCKED.

## 26. Historical Decision Traceability Matrix

### 26.1 Evidence/status vocabulary

- **Documented v3.4/v3.5:** present in an available project architecture document.
- **User-supplied history:** present in the historical decision list or supplied session summary, but original version document is unavailable.
- **Unavailable:** no primary source proves the decision or first version.
- **Preserved:** requirement and material conditions are included in v3.6.
- **Modified:** clarified or split without claiming prior approval; explanation is required.
- **Proposed:** new mechanism requiring approval.
- **Validation status:** documentary review only; no implementation/test evidence unless explicitly stated (none here).

### 26.2 Matrix

| Original decision | Historical evidence source | First known version | v3.6 destination | Status | Reason | Approval required | Validation status |
|---|---|---|---|---|---|---|---|
| Separate STM, WM, LTM | User-supplied history | Unavailable | 2, 4, 18 | Preserved | Maintain class boundaries and scoped retrieval | Retention/capacity choices | Not implemented/tested |
| Separate non-personal Knowledge Base from personal memory | User-supplied history | Unavailable | 2, 3, 4, 18 | Preserved | Separate namespace/access/retention/key domain | Physical design | Not validated |
| Small task-specific context; do not send all memory | User-supplied history; v3.5 | Unavailable | 2, 18, 21 | Preserved | Retain minimization and budget | Budget/scoring | Not measured |
| Multidimensional retrieval and related memories | User-supplied history | Unavailable | 4.5, 18 | Preserved | Keep relation/provenance/time dimensions | Score calibration | Not evaluated |
| Preserve source/date/confidence/importance | User-supplied history | Unavailable | 4.2-4.4 | Preserved | Preserve provenance and temporal context | Scales/policy | Not validated |
| Distinguish fact/inference/hypothesis | User-supplied history | Unavailable | 2, 4, 18, 19 | Preserved | Avoid claim promotion | Promotion rules | Not validated |
| Historical revisions; no silent deletion/overwrite | User-supplied history; v3.5 | Unavailable | 2, 5, 13 | Preserved | Append new events and redaction evidence | Retention/legal exceptions | Not implemented |
| Resumable Sleep-time Consolidation | User-supplied history; v3.5 | Unavailable | 19 | Preserved | Bounded checkpointed proposals | Job/checkpoint policy | Not tested |
| Learn from experience; testable/reversible Skills | User-supplied history; v3.5 | Unavailable | 20 | Preserved | Version, evaluate, review, rollback | Sandbox/criteria | Not tested |
| Bitemporal Transaction Time and Valid Time | User-supplied history | Unavailable | 4.3-4.4 | Preserved | Define separate knowledge and world time | Serialization | Not implemented |
| Half-open `[valid_from, valid_until)` | User-supplied history | Unavailable | 4.3 | Preserved | Retain exact interval convention | Schema mapping | Not tested |
| UNKNOWN, OPEN, UNBOUNDED distinct | User-supplied history | Unavailable | 4.3 | Preserved | Avoid sentinel conflation | Encoding | Not validated |
| Never guess unknown temporal bounds | User-supplied history | Unavailable | 2, 4.3 | Preserved | Unknown remains unknown | None for principle | Not tested |
| Append-only event log and current projection | User-supplied history; v3.5 | Unavailable | 5, 13 | Modified | Explicitly define Memory Event Log as logical Coordinator Journal partition; projections derived | Physical layout | Proposed topology, not implemented |
| One committed ordering authority | v3.4 §§2-4; user history | At least v3.4 documented | 2, 5, 7 | Preserved | Preserve single order source | Storage/HA choices | Not proven |
| `commit_sequence` monotonic, never reused | User-supplied history; v3.5 | Unavailable | 2, 5 | Preserved | Make sequence transaction scope explicit | Storage proof | Not proven |
| Separate `request_sequence` and `commit_sequence` | User-supplied history; v3.5 | Unavailable | 5, 7 | Preserved | Request order grants no permission | Queue design | Not implemented |
| Admission State is not a second ordering source | v3.4 §§3-4 | At least v3.4 documented | 3, 5, 7 | Preserved | Projection updated atomically with journal | Physical transaction | Not proven |
| Lease, Fencing Token, Generation | User-supplied history | Unavailable | 6.6, 7, 14 | Preserved/clarified | Separate fence from key generation | HA/fencing | Not proven |
| Consistency Token binds scope/state/permission/key/witness/manifest | User-supplied history; v3.5 | Unavailable | 3.2 | Preserved | Define binding fields | Token crypto/expiry | Not implemented |
| Witness binds Journal Revision, commit head, Deletion Revision | User-supplied history; v3.4 §§3,5,6 | Unavailable; v3.4 confirms general anchor | 6.6, 11 | Preserved with minimized visibility | Remove personal payload bindings from manifest | Witness contract | Not validated |
| ANCHORED_REGION / UNANCHORED_REGION | User-supplied history | Unavailable | 11.2 | Preserved | Define evidentiary boundary | Anchor policy | Not implemented |
| Fail closed for missing Coordinator/Witness/time/integrity | v3.4 §§1,5,6; user history | At least v3.4 partial | 2, 7, 14, 15, 22 | Preserved | Expand failure behavior | Time/Witness choices | Not tested |
| Separate Provider Send and Result Delivery | v3.4 §§1-4; user history | At least v3.4 documented | 8, 9 | Preserved/expanded | Separate gates, grants, receipts | Adapter contracts | Not implemented |
| `SEND_AUTHORIZED`, `SEND_STARTED`, `SEND_CONFIRMED`, `SEND_REJECTED`, `SEND_OUTCOME_UNKNOWN` | User-supplied history; v3.5 partial | Unavailable | 8 | Modified/expanded | Preserve required states; explicitly distinguish local start from invocation and add cancellation/boundary uncertainty | State/API compatibility | Not tested |
| `DELIVERY_AUTHORIZED`, `DELIVERY_STARTED`, `HANDOFF_CONFIRMED` | User-supplied history; v3.5 partial | Unavailable | 9 | Modified/expanded | Same local-start/Adapter boundary split | Delivery contract | Not tested |
| Unknown outcomes are not automatically retried | User-supplied history; v3.5 | Unavailable | 2, 8, 9, 22 | Preserved | Avoid duplicate external effects | Reconciliation contract | Not tested |
| Authorization bound to final payload/destination | User-supplied history; v3.5 | Unavailable | 6.3-6.4, 10 | Modified | Preserve verification while hiding content fingerprints | Crypto/vault policy | Not tested |
| Protected Egress Staging Store | User-supplied history; v3.5 | Unavailable | 3, 6, 10 | Preserved | Exact encrypted bytes verified at Gate | Retention | Not implemented |
| Adapter Receipt validation | User-supplied history; v3.5 | Unavailable | 6.4, 8, 9, 11 | Preserved | Receipt proves only its contract | Per-adapter semantics | No receipts tested |
| Independent audit keys, Canonical Audit Record, Operation MAC | User-supplied history; v3.5 | Unavailable | 6.1, 6.4 | Modified | MAC excludes raw payload digest; protected reference only | Suite/key custody | Not implemented |
| Idempotency Conflict | User-supplied history; v3.5 | Unavailable | 8, 9, 11, 13 | Preserved | Changed binding never overwrites original | Retention | Not tested |
| `STARTED` is not evidence of success | v3.4 §2; user history | At least v3.4 documented | 2, 7-9 | Modified/clarified | v3.5's phrase “Adapter invocation boundary crossed” was contradictory; v3.6 defines `*_STARTED` as local only | None for correction | Documentary correction only |
| Witness-First Deletion | v3.4 §§2,5; user history | At least v3.4 documented | 12-14 | Preserved | Tombstone anchor precedes key destruction | Witness contract | Not validated |
| Immediate local block on delete | User history; v3.4 §4 | At least v3.4 barrier documented | 7, 12 | Preserved/clarified | Gate closes on request; durable barrier/fence linearizes admission | Gate implementation | Not proven |
| Close visibility, contexts, caches, leases | User history; v3.4 §§3,5 | At least v3.4 partial | 12-14 | Preserved | Inventory and sequence made explicit | Completeness | Not tested |
| Anchor opaque tombstone before key destruction | User-supplied history; v3.5 | Unavailable | 11-13 | Preserved | Stable operation ID and exact manifest idempotency | Witness contract | Not implemented |
| Do not claim deletion before proof | v3.4 §§2,5; user history | At least v3.4 general rule | 12 | Modified/split | Ambiguous `DELETION_COMPLETED` replaced by local and external status dimensions | User approval for status contract | Not validated |
| Crash after anchor cannot roll back delete | v3.4 §5; user history | At least v3.4 principle | 12-14 | Preserved | Recovery is forward-only after anchor | Restore/keys proof | Not tested |
| Lost Protected Link Store means no guessed links | User-supplied history; v3.5 | Unavailable | 3, 13, 14 | Preserved | Quarantine and exact-source recovery only | Backup source | Not tested |
| Unprovable order -> `RECOVERY_REQUIRED` | v3.4 §§2,4,8 | At least v3.4 documented | 7, 14, 22 | Preserved | Explicitly includes Gate/failover ambiguity | Recovery authority | Not tested |
| Old backup cannot open gate before latest witness/tombstones/keys | v3.4 §5; v3.5 | At least v3.4 documented | 6.6, 14 | Preserved/expanded | Six independent generations/floors checked | Source availability | Not proven |
| Admission barrier races with send and delivery | supplied summary places barrier review at least in v3.3; v3.4 §4 also documents it | At least v3.3 by supplied summary | 7-9, 22, 27 | Modified | Gate's dispatch claim and delete barrier share one sequencer; external atomicity not assumed | Sequencer/HA approval | Proposed, not proven |
| Barrier is not second order source; barrier check alone is not atomicity | v3.4 §4 | At least v3.4 documented | 5, 7 | Preserved | Single journal authority and sequencer clarified | Implementation proof | Not proven |
| No Adapter call before proper durable authority | User-supplied history; v3.5 | Unavailable | 7-10 | Modified/clarified | `SEND_STARTED` alone is not call permission; Gate claim is distinct | Gate contract | Not tested |
| RPO/anchor values need owner approval | v3.4 §§6,10 | At least v3.4 documented | 15, 24 | Preserved | No arbitrary numbers | Yes, explicit | Not approved |
| Metadata privacy needs measured criteria, not claims | v3.4 §§7,10 | At least v3.4 documented | 6, 16, 17 | Preserved/expanded | Adds payload digest/linkability threat | Yes, thresholds | Not measured |
| Initial Retrieval Evaluation: 100 questions; Recall@5 >=90%; Precision@5 >=80%; temporal accuracy >=95% | User-supplied historical criteria in this request | Unavailable | 4.6, 17, 18, 26 | Preserved | Restored as targets without results; benchmark definition unavailable | Yes, confirm suitability/data/oracle | Not run |
| Low-risk Skill Evaluation: >=5 independent trials; >=90%; independent test; no critical failure; human review; rollback criteria | User-supplied historical criteria in this request | Unavailable | 20.1-20.2, 26 | Preserved with scope | Explicitly limited to approved low-risk category; no universal guarantee | Yes, risk taxonomy/exceptions | Not run |
| Vertical Slice: one Claim, one Source, event, permissions, correction, current/historical query, transaction, projection rebuild, synthetic deletion test | User-supplied historical criteria in this request | Unavailable | 23, 26 | Preserved | Marked future-only; not implemented/executed | Yes, future test plan | Not run |
| Payload digest/MAC must not expose personal content in journal/Witness | New requirement in v3.6 request; risk implied by v3.5 §5.2/6.3/10/11/17 | v3.6 request | 5.2, 6.3-6.5, 10-11, 16, 27 | Proposed correction | Private per-operation binding vault; Witness gets no payload digest/MAC | Yes, crypto/privacy design | Not implemented/tested |
| Separate local deletion completion from remote effect/deletion | New requirement in v3.6 request correcting v3.5 §12.4 | v3.6 request | 12, 22, 27 | Modified | No generic status may imply provider erasure | Yes, status/reporting contract | Not implemented |
| Separate Coordinator Epoch, Fencing Generation, Key Generation, Deletion/Witness/Journal Revision | User-supplied historical generation concepts; explicit separation requested here | Unavailable | 6.6, 14, 26, 27 | Preserved/clarified | Prevent generation conflation and backup rollback | Yes, authoritative storage design | Not implemented |

### 26.3 Traceability conclusion

The v1.0-v3.3 source files remain unavailable. For those rows, the supplied history is the evidence source, not a verified original specification. “Preserved” means the requirement and known conditions are represented here, not that implementation or historical wording has been independently proven. If an original document later conflicts with this matrix, record the difference as a regression/blocker; do not silently prefer v3.6.

## 27. Internal Contradiction Review

This is a documentary consistency review only. It is not a test result or proof of execution correctness.

| Conflict / locations | Cause | v3.6 correction | Status after document review | Still unproven |
|---|---|---|---|---|
| `SEND_STARTED` vs Adapter boundary; v3.5 §§8.1-8.2 and 10.3 | v3.5 described `SEND_STARTED` as Adapter invocation while also calling it a local start | Sections 7-8 define it as local operation start; dispatch claim and Adapter-entry evidence are separate | Clarified in specification | Gate implementation/crash proof BLOCKER |
| Send vs delete; v3.5 §§7-8,12 | A barrier could commit after `SEND_STARTED` but before worker Adapter attempt | Shared per-scope sequencer; barrier-first rejects; prior dispatch slot enters Adapter before barrier commit or is fenced/unknown on crash | Scenario defined | Single Gate/failover exclusion BLOCKER |
| Delivery vs delete; v3.5 §9 | Delivery inherited same ambiguous start boundary | Separate Delivery Gate and equivalent transition/race rules | Clarified | Receiver adapter/fencing contract BLOCKER |
| Authorization vs payload; v3.5 §§6.3,10.1 | Digest in public audit/token leaks content-derived equality/inference | Per-operation protected commitment and random reference; re-verify exact staged bytes | Data path defined | Crypto scheme/key handling BLOCKER |
| Payload digest/MAC vs privacy; v3.5 §§5.2,6.3,11 | Journal/witness-visible digest or MAC can be linkable | No raw digest/MAC or binding handle sent to Witness; minimal global manifest; binding proof destroyed with key | Disclosure path limited | Global root/timing leakage still needs measurement |
| Append-only vs deletion; v3.5 §§5,12-13 | History retention could imply content must remain readable | Append control/redaction events; destroy content/binding keys and remove links; retain only minimal order evidence | Semantics separated | Physical media/backup residual proof BLOCKER |
| Coordinator Journal vs Memory Event Log; v3.5 §§3,5 | Physical/logical relationship unspecified | Memory Event Log is a logical event category in canonical Journal; indexes/projections rebuildable | Decision made as proposal | Physical storage/transaction choice BLOCKER |
| Witness vs Backup Restore; v3.5 §§11,14-15 | Hash anchor cannot reconstruct missing event bodies | Restore requires current authenticated Journal replica plus witness/tombstone/key checks | Limitation explicit | Journal DR source BLOCKER |
| Tombstone vs Key Erasure; v3.5 §§12-13 | Ordering and crash continuation could be read ambiguously | Witness tombstone must validate before key destruction; after anchor recovery is forward-only | Order explicit | Witness contract/erasure evidence BLOCKER |
| Unknown external outcome vs deletion; v3.5 §12.4 | One completion status could falsely claim remote resolution or block local completion indefinitely | Local completion may be recorded independently; unknown remote status remains visible and unresolved; no generic `DELETION_COMPLETED` | Status dimensions separated | Product reporting/residual-risk policy BLOCKER |
| Generation concepts; v3.5 §§3,6,7,11,13-15 | Epoch, fence, key and revisions could be conflated | Section 6.6 gives each authority, source, increment, invalidation, restore rule | Definitions separated | Concrete authoritative mechanisms BLOCKER |
| Visibility Gate vs recovery; v3.5 §§3,14-15 | A local state might open visibility before current proof | Closed by default; ordered recovery table precedes minimal gate opening | Ordering specified | Gate enforcement and failover proof BLOCKER |
| Witness ambiguous response / retry; v3.5 §§11,12 | Could create duplicate/conflicting tombstones | Stable tombstone operation ID + exact manifest + query same Witness operation | Idempotency rule specified | Witness must support contract; BLOCKER |

## Final status

**Consolidated corrective design proposal — not approved for implementation.**

v3.6 preserves the known v3.5 decisions, corrects the documented contradictions above, and marks new mechanisms as proposals requiring approval. It does not establish operational atomicity, payload privacy, deletion completeness, or metadata unlinkability. Original v1.0-v3.3 source documents remain unavailable; RPO/Witness terms, cryptographic choices, evaluation definitions, Gate failover, and external contracts remain BLOCKERS. Phase A and Phase B are not authorized.
