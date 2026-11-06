# Jarvis Memory Architecture v3.5

Status: consolidated design proposal; implementation, testing, simulation, and Phase A/B remain unauthorized.

Document date: 2026-11-03
Supersedes for design review: `docs/jarvis-memory-architecture-v3.4.md`

This is a self-contained architecture specification. It consolidates the historical decisions supplied for this review and the verified constraints in v3.4. It does not claim that unavailable v1.0-v3.3 source documents were reviewed. The exact release in which each historical decision was introduced is marked unknown where no primary version source is available. Mechanisms introduced here to make a decision operational are design proposals, not evidence of prior approval or proof of a working implementation.

No code, database, schema, credential, service, live data, or test/simulation process is authorized by this document.

## 1. Purpose, Scope and Non-Goals

### 1.1 Purpose

Define a coherent architecture for Jarvis memory, temporal semantics, append-only event history, encryption, Coordinator ordering, provider egress, result delivery, witness anchoring, deletion, backup recovery, retrieval, consolidation, learning, and privacy review.

The central security objective is to ensure that no uncertain ordering, stale worker, unknown external outcome, stale backup, or unverified deletion can silently become an authorized success or reopen visibility.

### 1.2 Scope

The design covers:

- short-term, working, long-term, and non-personal knowledge-base boundaries;
- event sourcing, bitemporal records, and historical interpretation;
- key separation, authenticated encryption, audit MACs, and key-generation revocation;
- Coordinator serialization, admission fences, request/commit ordering, and durable operation states;
- independent Provider Send and Result Delivery protocols;
- authorization bound to immutable payloads;
- witness anchors, deletion tombstones, restore protection, recovery, RPO, and metadata minimization;
- retrieval and context budgets, sleep-time consolidation, and versioned skills;
- explicit assumptions, open decisions, historical traceability, and readiness gates.

### 1.3 Non-goals and authority limits

This document is not:

- a claim that the architecture is implemented, secure, privacy-preserving, or validated;
- permission to begin Phase A or Phase B, implementation, testing, simulation, migration, or deployment;
- a choice of vendor, witness, database, HSM/KMS, OS keystore, time authority, or cryptographic library;
- a replacement for threat-model approval, operational policy, legal review, or user consent;
- a promise that an external provider can retract a send after the provider has received it.

The original v1.0-v3.3 documents and a complete revision log were not found in the project. Historical release attribution must therefore remain marked unavailable unless separately supplied.

## 2. Architecture Principles and Security Invariants

The following are normative invariants for the proposed architecture. An invariant without its required mechanism and evidence remains a design requirement, not a proven guarantee.

1. **One committed ordering authority.** The Coordinator Journal is the only authority that assigns committed order. Derived projections, request arrival timestamps, local locks, adapters, and witnesses do not create competing order.
2. **Monotonic commit sequence.** `commit_sequence` increases for each committed Coordinator Journal event and is never reused. Gaps are allowed; reuse is not. Sequence allocation and the journal append commit atomically inside the Coordinator store.
3. **Separate request order and commit order.** `request_sequence` describes durable Coordinator ingress arbitration. It is not proof of commit. `commit_sequence` describes the order of committed state transitions.
4. **No success from STARTED.** A send or delivery `STARTED` event means only that the locally controlled operation crossed its defined start boundary. It is not proof of external acceptance, transfer, handoff, or user receipt.
5. **Unknown remains unknown.** `SEND_OUTCOME_UNKNOWN`, delivery handoff uncertainty, missing receipts, lost replies, or inconsistent recovery evidence never turn automatically into success, rejection, or a retry.
6. **No Adapter before durable authorization.** An Adapter cannot be invoked before the Coordinator commits the appropriate operation authorization and the Adapter validates its current fencing token and immutable operation binding.
7. **Independent send and delivery.** Provider Send and Result Delivery are separate state machines, authorizations, operation IDs, receipts, and audit records.
8. **Payload-bound authorization.** Authorization applies only to the exact canonical payload, destination, policy, and transformation version whose digest was approved.
9. **Fail closed.** Missing Coordinator, witness, trusted time where required, journal integrity, current fence, key-generation proof, tombstone evidence, or ordering proof blocks the affected action and may require `RECOVERY_REQUIRED`.
10. **Witness-first deletion.** A locally requested deletion is immediately blocked locally but is not rollback-resistant or complete until its opaque tombstone is externally anchored and the deletion protocol finishes.
11. **No revival.** A retired or deleted key generation, tombstone, permission, receipt, lease, or stale backup cannot grant new authority or reactivate deleted data.
12. **No inferred identity links.** Loss of the Protected Link Store is not repaired by guessing. Unresolvable mappings require quarantine and recovery.
13. **Personal data minimization.** Persistent Coordinator, witness, tombstone, and audit records contain no unnecessary personal content or direct identifiers. Metadata is still treated as sensitive.
14. **No silent history rewrite.** Memory changes are append-only events with explicit provenance and revision history. Current projections are rebuildable views, not substitutes for history.
15. **No privacy claim without evidence.** Metadata privacy remains unvalidated until an approved threat model, baseline, test set, metrics, thresholds, confidence level, and reproducible results exist.

## 3. Complete System Components and Trust Boundaries

### 3.1 Components

| Component | Responsibility | Trusted authority / limitation |
|---|---|---|
| Coordinator Service | Serializes per-scope requests; checks policy, fences, deletion barriers, and operation state | Only authority that commits ordered decisions |
| Coordinator Journal | Append-only committed event stream, hash-linked revisions, monotonic `commit_sequence` | Durable ordering source; integrity and durability must be established by deployment design |
| Coordinator Admission State | Current admission/barrier projection materialized from committed journal events | Not an independent ordering source; must be transactionally updated with its journal event |
| Request Inbox | Durable accepted-request queue with `request_sequence` and idempotency key | Arrival arbitration only; queued request is not authorization or commit |
| Egress Broker | Validates committed send grant, current fence, staged payload digest, and adapter receipt | Must not infer success from invocation or timeout |
| Provider Adapter | External provider boundary for send | Cannot atomically transact with Coordinator; external outcome can be unknown |
| Result Delivery Broker / Adapter | Separate user-facing delivery boundary | Separate grant and receipt; must not reuse send state as delivery proof |
| Protected Egress Staging Store | Holds the immutable encrypted final payload and operation metadata pending send | Access only under a committed grant; deleted/expired under explicit policy |
| Memory Event Log | Append-only memory, provenance, temporal, consolidation, and skill events | Commits receive order from Coordinator; it cannot assign a competing commit sequence |
| Current Projections and Indexes | Rebuildable retrieval views, graph edges, caches, embeddings, and summaries | Derived and disposable; never the sole source of truth |
| Knowledge Base | Non-personal, sourced domain knowledge | Separated by namespace, key domain, policy, and retrieval boundary from personal memory |
| Key Store / Key Generation Ledger | Envelope keys, key status, generation, revocation, destruction evidence | Must reject retired generations and rollback; exact technology is open |
| Deletion Ledger / Tombstone Store | Opaque delete intents, tombstones, deletion revisions, cleanup attestations | Linkability minimized; authoritative deletion evidence must reconcile with Coordinator and witness |
| Protected Link Store | Separately encrypted mapping from opaque subject/scope tokens to local objects and artifacts | Loss means no guessing or inferred reconstruction |
| Witness Service | External monotonic anchor for journal revision, commit sequence, deletion revision, and manifest | Trust, consistency, availability, and freshness contract are open blockers |
| Trusted Time Source | Supplies validated time when leases or wall-time claims require it | Wall clock alone is not trusted for order or lease expiry |
| Visibility Gate | Enforces whether data, keys, contexts, and retrieval results may be exposed | Must remain closed until deterministic recovery checks pass |
| Backup / Restore Manager | Creates and restores encrypted snapshots; reconciles them to latest external state | A snapshot is untrusted until witness/tombstone/key checks complete |
| Privacy Router | Selects local/cloud execution under policy and sensitivity classification | No cloud fallback for blocked/sensitive content; classification uncertainty fails closed |
| Consolidation Worker | Creates reviewable, resumable proposals from eligible local events | Cannot silently overwrite confirmed memories or invoke an unapproved remote model |
| Skill Registry / Evaluator | Stores versioned, testable skill artifacts and rollback pointers | Skills are not trusted executable instructions until separately approved |

### 3.2 Trust boundaries

1. **Local process boundary:** process memory and locks protect against concurrent local operations only. They are not durable rollback protection.
2. **Coordinator storage boundary:** a single transactional Coordinator store is required for journal append, commit sequence, and Admission State transition. Whether this can meet durability and platform requirements is an open implementation decision.
3. **Adapter boundary:** the external call cannot share an atomic transaction with the Coordinator. Fencing and immutable grants reduce stale calls but cannot retract an already accepted external operation.
4. **Witness boundary:** the witness is an independent trust domain. A local record saying “anchored” is insufficient without authenticated witness proof and freshness validation.
5. **Key boundary:** data encryption, identity/link mapping, and audit authentication keys are separate security domains.
6. **Backup boundary:** backups may be stale, copied, restored, or replayed. A backup never overrides a newer witness deletion revision.
7. **Cloud boundary:** prompt/context data crossing to a provider is an explicit egress event and must be minimized, authorized, routed, and audited.

### 3.3 Consistency Token

A Coordinator-issued Consistency Token is an integrity-protected assertion binding at minimum:

- opaque scope and operation identifiers;
- Coordinator identity and fencing generation;
- relevant `commit_sequence`, journal revision, and admission state;
- authorization and policy revision;
- payload digest and destination for egress grants;
- applicable key-generation and deletion revisions;
- witness anchor revision/status and manifest hash;
- token issue/expiry constraints where trusted time is required.

Tokens are operation-specific, audience-restricted, short-lived under an approved trusted-time policy, and non-transferable to another payload, scope, or operation. They do not replace the journal or witness record.

## 4. Memory Data Model and Bitemporal Semantics

### 4.1 Memory classes

- **Short-Term Memory (STM):** recent session events with explicit TTL/capacity; isolated from durable Long-Term Memory (LTM) unless separately reviewed and explicitly promoted.
- **Working Memory (WM):** task-scoped, temporary values; isolated by task and cleared by defined expiry/completion policy.
- **Long-Term Memory (LTM):** user-specific durable facts, preferences, goals, projects, decisions, and reviewed inferences.
- **Knowledge Base (KB):** sourced, non-personal reference knowledge. It is not personal memory and must use separate namespaces, authorization, retention, and key domains.
- **Consolidation proposals:** candidate changes that remain non-authoritative until reviewed and committed as new memory events.
- **Skills:** versioned procedural artifacts learned from evaluated experience; separately authorized from facts and KB.

No request sends the full memory store to a model. Retrieval is task-specific, bounded, and filtered.

### 4.2 Record fields

A logical memory revision includes, subject to privacy minimization:

- opaque record, scope, and revision IDs;
- class/type and namespace;
- value/content ciphertext reference;
- source/provenance and source event reference;
- epistemic label: `FACT`, `INFERENCE`, or `HYPOTHESIS`;
- confidence and importance with their defined scales and calibration status;
- `transaction_time` as Coordinator commit sequence/revision;
- `valid_time` represented as a half-open interval `[valid_from, valid_until)` with typed boundary states;
- supersedes/retracts relationships, never silent overwrite;
- encryption key generation and authenticated format version;
- policy/consent/retention classification where applicable.

Direct personal identifiers should not be copied into event metadata. Any necessary identity mapping resides in the separately encrypted Protected Link Store.

### 4.3 Bitemporal rules

- `transaction_time` records when the system learned or committed a claim. Its authoritative order is the Coordinator Journal, not a wall clock.
- `valid_time` records when the claim applies in the modeled world.
- All finite validity intervals are half-open: `[valid_from, valid_until)`.
- A correction appends a new revision and a supersession/retraction event. The old revision remains available to authorized historical queries until a valid deletion policy removes its content.
- No unknown boundary is inferred from neighboring records, a model answer, or current time.

Boundary values are typed, not overloaded:

| Value | Meaning | Required behavior |
|---|---|---|
| `UNKNOWN` | Boundary value is not known | Preserve as unknown; do not infer or compare as a concrete date |
| `OPEN` | Boundary is intentionally not yet closed / may be updated | Preserve explicit open status; not equivalent to infinity |
| `UNBOUNDED` | Domain explicitly says there is no bound on this side | Treat as a semantic unbounded sentinel, not a guessed timestamp |
| Finite value | Known boundary | Validate interval ordering and half-open semantics |

Invalid or contradictory intervals are rejected or marked for review; they are not silently normalized.

### 4.4 Historical interpretation

Two query modes are distinct:

- **Knowledge-at-the-time:** only claims committed by the specified transaction sequence are visible, with their then-known provenance and validity assertions.
- **Best-current-historical-understanding:** current corrected understanding is applied to a historical valid-time question, while retaining the later correction/provenance chain.

The API and rendered answer must identify which interpretation was requested. A later correction must not be presented as if it were known earlier.

### 4.5 Retrieval representation

Retrieval supports multiple dimensions: lexical/semantic relevance, temporal validity, provenance quality, confidence, importance, recency when meaningful, task scope, and explicit graph relationships. Scores and their calibration are not yet specified. Relationship edges are typed and sourced; no relationship is invented merely because two records co-occur.

## 5. Event Journal and Ordering Authority

### 5.1 Journal roles

The Coordinator Journal is the single ordering authority for all committed state transitions covered by this architecture, including admission, authorization, memory events, send/delivery transitions, deletion revisions, and recovery actions. An implementation may maintain derived subsystem logs, but those logs must reference Coordinator commit IDs and may not establish a competing order.

The Memory Event Log is append-only. A projection is updated in the same Coordinator transaction as its event when it is a Coordinator-owned projection; external indexes are asynchronous derived state and are rebuilt or invalidated from committed journal data.

### 5.2 Event envelope

A minimal committed event envelope contains:

- schema/version and event type;
- opaque event, scope, and operation IDs;
- Coordinator identity/epoch and strictly increasing `commit_sequence`;
- prior journal hash and event hash/MAC references;
- policy, authorization, and key-generation revisions needed for validation;
- payload digest or encrypted payload reference, never unnecessary plaintext;
- idempotency key hash and causal references where needed;
- witness/deletion revision references when applicable.

Timestamp precision, envelope size, stable identifiers, and event type leakage are privacy risks and remain subject to Section 17.

### 5.3 Request order vs commit order

`request_sequence` is assigned by the durable Coordinator ingress arbitration mechanism. It establishes deterministic processing order among requests accepted into that queue, but it is not a commit and grants no permission. A request can be rejected, blocked, or require recovery without receiving a committed state transition.

`commit_sequence` is assigned only inside the durable transaction that appends the committed event and updates the Coordinator Admission State projection. It is strictly monotonic and never reused. Request wall-clock timestamps do not arbitrate a race.

### 5.4 Durability and hash chain

The journal append, committed sequence allocation, and Coordinator-owned Admission State update must succeed or fail as one local Coordinator database transaction with documented durability semantics. The transaction boundary does not include Witness, Provider Adapter, result receiver, or external indexes.

A hash chain or equivalent tamper-evident commitment is required, with periodic witness anchoring. Hash/MAC key design and exact durability settings require approval. Integrity verification failure forces `RECOVERY_REQUIRED`.

## 6. Cryptography and Key Lifecycle

### 6.1 Envelope encryption

- Encrypt memory content and protected staged payloads with per-record or per-object Data Encryption Keys (DEKs).
- Wrap DEKs under Key Encryption Keys (KEKs) protected by an approved OS keystore/HSM/KMS boundary.
- Keep key material out of journal payloads, logs, receipts, URLs, and prompts.
- Use distinct, independently generated key domains for content encryption, protected identity/link mappings, and audit MACs. Do not reuse one key for encryption and authentication.
- Key algorithms, sizes, provider, certification requirements, and cryptographic module are deployment decisions and BLOCKERS; no specific production suite is asserted as approved here.

### 6.2 AEAD, nonce, and AAD requirements

Every ciphertext must use an approved AEAD construction. Its format must bind as AAD at least the record/object opaque ID, namespace, data class, schema/format version, key generation, and relevant scope/purpose. AAD must not include mutable fields unless re-encryption is performed when they change.

Nonce requirements:

- nonce size and construction must follow the selected AEAD standard;
- no `(key, nonce)` pair may ever be reused;
- retry/replay of an already-created ciphertext reuses the exact stored ciphertext, not a second encryption with the same key/nonce;
- re-encryption uses a fresh key or a durably unique nonce allocator whose rollback behavior is proven;
- restore/rollback uncertainty invalidates the affected encryption generation until uniqueness can be re-established.

The exact suite, nonce allocator design, and backup rollback behavior are unresolved and must be selected before implementation.

### 6.3 Audit MAC and canonical audit records

Each operation has an audit key independent of its content key. A Canonical Audit Record is deterministically encoded and binds operation ID, scope token, event type/state, Coordinator commit sequence, fence generation, payload digest, destination/policy binding, receipt digest/status, and relevant key/witness/deletion revisions. An Operation MAC authenticates this record.

Canonicalization format, MAC algorithm, key custody, rotation, and verifier deployment require approval. MAC validity proves integrity under the audit key; it does not prove that the external provider performed the claimed action.

### 6.4 Key generations and erasure

Every content, link, and audit key belongs to a monotonically versioned generation with status such as `ACTIVE`, `FROZEN`, `REVOKED`, `DESTROY_PENDING`, or `DESTROYED`. State transitions are journaled and deletion revisions anchored as required. A generation once revoked/destroyed is never reactivated, including from backup.

Cryptographic erasure requires destruction of all usable copies/wrappings of the applicable DEKs/KEKs and invalidation of caches and copies. Physical media erasure, key escrow, backup retention, replication, and evidence of destruction are deployment decisions; until solved, “deleted” must not imply universal physical erasure.

## 7. Atomic Coordinator Admission Protocol

### 7.1 Single synchronization source and linearization point

The only permitted synchronization authority is the Coordinator's durable transactional state machine for the affected scope. It serializes competing requests through a per-scope durable inbox/queue and a single-writer or serializable transaction mechanism. Local locks may reduce contention but are not part of the proof.

The linearization point for a decision is the durable commit of one Coordinator transaction that:

1. checks expected admission revision and fence generation;
2. checks deletion barrier and operation preconditions;
3. appends the decision event with the next never-reused committed sequence;
4. updates the Coordinator Admission State projection and operation record;
5. records the committed grant or rejection.

The event, sequence, projection, and grant must be atomic within that Coordinator transaction. If the chosen database cannot provide the required transaction and durability, the architecture is not implementable on that storage as specified.

### 7.2 Ordering two concurrent requests

Requests are first accepted into the Coordinator queue under a durable arbitration point and assigned `request_sequence`. The Coordinator processes a scope's queue in that order. If concurrent arrivals reach arbitration simultaneously, whichever durable queue insertion is serialized first wins; this order is determined by the Coordinator transaction, never client timestamps.

A delete barrier takes effect at the commit of `DELETE_REQUESTED`/barrier-activation in the Coordinator Journal. Any send/delivery admission transaction linearized after that commit is rejected. An operation whose required authorization was committed before the barrier may already be externally in flight; it is not retroactively made un-sent. The deletion protocol records and resolves that in-flight operation as confirmed, rejected, or unknown before it can declare final completion. This boundary cannot guarantee that an external provider will cancel an already accepted request.

### 7.3 Lock, CAS, and transaction roles

| Mechanism | Role | What it cannot prove |
|---|---|---|
| In-process mutex | Performance/local race reduction | Durability, cross-process exclusion, rollback safety, or atomicity with Adapter/Witness |
| Durable queue sequence | Deterministic arbitration among accepted requests | Commit or permission; sequence is not an event commit |
| CAS on expected Coordinator revision/fence | Reject stale writers inside the Coordinator transaction | Atomicity with external services or correctness if used outside that transaction |
| Coordinator database transaction | Atomic journal append + sequence + Coordinator-owned Admission State + operation state/grant | Atomic commit with Witness, Adapter, external indexes, or user receiver |
| Lease + fencing generation | Prevent an obsolete worker from obtaining new authority | Undo an external operation already accepted before revocation |
| Adapter-side fence validation | Reject stale grant immediately before the adapter invocation boundary | Guarantee the provider has not already accepted a prior invocation |

### 7.4 Worker fencing and Adapter boundary

Every worker carries `(coordinator_epoch, fence_generation, operation_id, committed_grant_id)`. Before any Adapter call, the Egress Broker validates online that:

- the grant is committed and unexpired under trusted time policy;
- the current scope barrier is not active;
- the token generation equals the current generation;
- the staged payload and destination match the grant digest;
- the operation has not been superseded, revoked, or already invoked.

The adapter receives only a single-use operation envelope. Where feasible, the adapter independently validates a signed fence/grant. A worker holding a stale in-memory lease cannot refresh or bypass this check. On deletion, the Coordinator increments/revokes the generation in the same barrier commit; all older generations are rejected.

There is an unavoidable call-boundary ambiguity: a crash/network loss after the Adapter has accepted a request but before a receipt is committed may leave the external effect unknown. The system must not retry automatically or report success. This is a declared limitation, not solved by a local transaction.

### 7.5 Crash cases

| Crash point | Durable fact | Recovery behavior |
|---|---|---|
| Before queue insertion | No accepted request | Caller may submit again with same idempotency key; no operation exists |
| After queue insertion, before decision | Request exists, no grant | Resume serialized queue processing; do not call Adapter |
| During Coordinator transaction before commit | Transaction is absent after recovery | Re-read journal; process request once by idempotency key |
| Immediately after commit, before worker sees grant | Decision is committed | Worker may fetch grant and continue only after fresh fence/payload checks |
| After barrier commit | Barrier and new fence are durable | All later admissions fail; stale workers fail fence check |
| Between final Adapter check and external acceptance | External outcome may be unknown | Record `SEND_OUTCOME_UNKNOWN`; no automatic retry |
| After Adapter effect, before receipt/commit | External outcome may be unknown | Reconcile only through authenticated receipt/query or manual recovery; never infer |

### 7.6 Atomic admission state machine

| Previous state | Trigger | Preconditions / authority | Durable commit | Next state | On failure |
|---|---|---|---|---|---|
| `OPEN` | Send/delivery request | Coordinator queue head; no barrier; valid policy and fence | Commit admission decision and scoped grant | `OPEN` with operation admitted | Reject or `RECOVERY_REQUIRED` if state/order cannot be proven |
| `OPEN` | Delete requested | Authorized delete principal; request idempotency valid | Commit delete intent, barrier, fence increment, admission projection | `DELETE_BARRIER_ACTIVE` | No barrier claim until transaction outcome resolved; restart reads journal |
| `DELETE_BARRIER_ACTIVE` | Any new send/delivery request | Coordinator transaction observes barrier | Commit rejection/audit event if required | `DELETE_BARRIER_ACTIVE` | Fail closed |
| `DELETE_BARRIER_ACTIVE` | Pre-barrier operation reconciliation | Operation was admitted before barrier | Commit confirmed/rejected/unknown reconciliation | `DELETE_BARRIER_ACTIVE` | Unknown remains unresolved; deletion cannot finalize |
| Any | Integrity/fence/sequence contradiction | Coordinator or recovery authority | Commit recovery event only if journal integrity is established | `RECOVERY_REQUIRED` | Visibility and egress remain closed |
| `RECOVERY_REQUIRED` | Authorized recovery completion | All Section 15 proofs pass | Commit recovery resolution and new fence | `OPEN` or `DELETE_BARRIER_ACTIVE` as proven | Remain blocked |

## 8. Provider Send State Machine

### 8.1 State semantics

`SEND_AUTHORIZED` is a committed, payload-bound grant. `SEND_STARTED` is a committed record that the Adapter invocation boundary was crossed, not provider success. `SEND_CONFIRMED` requires a validated Adapter Receipt satisfying the configured evidence contract. `SEND_REJECTED` requires an authenticated explicit rejection. `SEND_OUTCOME_UNKNOWN` covers timeouts, lost responses, crashes, malformed/missing receipts, or conflicting evidence.

A send in `SEND_OUTCOME_UNKNOWN` is terminal for execution. It may be reclassified only when authenticated evidence establishes the outcome. Human approval cannot convert uncertainty into a retry or success; if the outcome cannot be proven, it remains unknown and must not be repeated under the same operation.

### 8.2 Send transition table

| Previous state | Event | Preconditions | Authority | Required durable commit | Next state | Failure behavior |
|---|---|---|---|---|---|---|
| `NONE` | authorize send | Valid consent/policy; immutable staged payload; destination; idempotency key; no delete barrier; current fence | Coordinator | `SEND_AUTHORIZED` with payload digest, destination, policy, fence and operation ID | `SEND_AUTHORIZED` | Deny; no Adapter call |
| `SEND_AUTHORIZED` | start invocation | Current grant/fence revalidated; staged bytes hash correctly; single-use dispatch marker acquired | Egress Broker under Coordinator grant | Commit `SEND_STARTED` before Adapter call | `SEND_STARTED` | If commit uncertain, do not call Adapter; recover journal |
| `SEND_STARTED` | authenticated positive receipt | Receipt authentic, operation/digest/destination/fence match, freshness and replay checks pass | Receipt verifier + Coordinator | Commit canonical audit record and Operation MAC | `SEND_CONFIRMED` | Invalid/missing receipt => `SEND_OUTCOME_UNKNOWN` or recovery |
| `SEND_STARTED` | authenticated explicit rejection | Receipt verifies and rejection is definitive for this operation | Receipt verifier + Coordinator | Commit receipt digest and audit MAC | `SEND_REJECTED` | Ambiguous rejection => `SEND_OUTCOME_UNKNOWN` |
| `SEND_STARTED` | timeout/crash/lost response | No definitive validated receipt | Coordinator recovery path | Commit unknown status when journal available | `SEND_OUTCOME_UNKNOWN` | No automatic retry or success claim |
| `SEND_AUTHORIZED` | revoke before invocation | No committed `SEND_STARTED`; grant still current | Coordinator | Commit revocation/fence transition | `SEND_REJECTED` with reason `REVOKED_BEFORE_START` | If invocation may have occurred, unknown instead |
| Any nonterminal | idempotency key reused with different binding | Hash/destination/scope/policy mismatch | Coordinator | Commit `Idempotency Conflict` security event | unchanged original + conflict record | Reject new call; never overwrite original |
| `SEND_OUTCOME_UNKNOWN` | reconcile | Authenticated provider query/receipt or approved manual process proves outcome | Recovery authority + Coordinator | Commit reconciliation evidence | `SEND_CONFIRMED`, `SEND_REJECTED`, or remain unknown | No evidence: remain unknown |

### 8.3 Adapter Receipt

A receipt must be authenticated according to the provider/adapter trust contract and bind operation ID, payload digest, destination, provider identity, result classification, adapter request ID, and any provider sequence/time evidence. Receipt validity does not prove more than its stated semantics. If the provider cannot produce a receipt meeting the agreed contract, the send may remain permanently unknown.

## 9. Result Delivery State Machine

### 9.1 Separation and states

Result delivery is a new operation with its own operation ID, payload digest, destination, authorization, fence check, Adapter Receipt, and Operation MAC. A confirmed provider send does not authorize delivery of its result; a result may be delivered only under a separately committed `DELIVERY_AUTHORIZED` decision.

`HANDOFF_CONFIRMED` means the configured delivery boundary has confirmed handoff, not that a human read or understood the result unless the receiver supplies that evidence.

### 9.2 Delivery transition table

| Previous state | Event | Preconditions | Authority | Required durable commit | Next state | Failure behavior |
|---|---|---|---|---|---|---|
| `NONE` | authorize delivery | Result exists; delivery policy/consent valid; immutable result digest and destination bound; no barrier; independent operation ID | Coordinator | Commit `DELIVERY_AUTHORIZED` and scoped grant | `DELIVERY_AUTHORIZED` | Deny; no delivery adapter call |
| `DELIVERY_AUTHORIZED` | start handoff | Fresh fence and grant; payload digest verified; single-use dispatch marker | Delivery Broker | Commit `DELIVERY_STARTED` before handoff | `DELIVERY_STARTED` | No handoff if commit uncertain |
| `DELIVERY_STARTED` | authenticated handoff receipt | Receipt binds operation and payload; configured semantics met | Receipt verifier + Coordinator | Commit canonical audit record and MAC | `HANDOFF_CONFIRMED` | Invalid or absent receipt => unknown |
| `DELIVERY_STARTED` | definitive rejection | Authenticated receiver/adapter rejection | Receipt verifier + Coordinator | Commit rejection and evidence | `DELIVERY_REJECTED` | Ambiguous response => unknown |
| `DELIVERY_STARTED` | timeout/crash/lost response | No definitive receipt | Coordinator recovery path | Commit uncertainty | `DELIVERY_OUTCOME_UNKNOWN` | No auto-retry or success claim |
| `DELIVERY_AUTHORIZED` | revoke before start | No `DELIVERY_STARTED` committed | Coordinator | Commit revocation | `DELIVERY_REJECTED` (`REVOKED_BEFORE_START`) | If call may have occurred, unknown |
| Any | idempotency conflict | Reused key has changed binding | Coordinator | Commit conflict event | Original unchanged | Reject conflict |
| `DELIVERY_OUTCOME_UNKNOWN` | reconcile | Authenticated receiver evidence or approved manual process | Recovery authority + Coordinator | Commit evidence and resolution | confirmed/rejected or unknown | Remain unknown without proof |

## 10. Authorization and Payload Binding

### 10.1 Authorization object

Authorization is a narrow, revocable, single-operation capability containing:

- opaque operation and scope IDs;
- action (`SEND` or `DELIVERY`), destination/provider/receiver identity;
- canonical payload digest and content format/version;
- transformation/redaction version and policy revision;
- consent or approval reference and its scope;
- Coordinator commit sequence, coordinator epoch, and fence generation;
- idempotency key digest, expiry policy, and single-use marker;
- applicable deletion/key/witness revision constraints.

Changing a byte, destination, transformation, policy, scope, or receiver invalidates the authorization and requires a new review/commit.

### 10.2 Canonicalization and staging

The final payload is assembled, minimized, and canonicalized before authorization. It is placed in the Protected Egress Staging Store encrypted with its own key domain. The digest is computed over the exact bytes that the Adapter will receive. No later layer may silently transform the payload. Any required transformation occurs before digest/approval and is named by version.

The staging store releases bytes only to a currently authorized Egress Broker. Expiry, deletion, revocation, and backup retention rules must be defined before implementation. Staging data is included in deletion and restore inventories.

### 10.3 Approval and adapter sequencing

1. Build final minimized payload.
2. Canonicalize and hash; store encrypted staging object.
3. Obtain explicit action-specific authorization bound to digest and destination.
4. Coordinator commits authorization and fence.
5. Broker revalidates current authorization, admission state, digest, and fence.
6. Coordinator durably records `SEND_STARTED`/`DELIVERY_STARTED` before invoking the respective Adapter.
7. Adapter receipt is verified and committed separately.

A deletion barrier that commits before steps 4-6 rejects the operation. If the barrier races after a prior authorization but before durable start, the fence check rejects it. If the Adapter may already have accepted the operation, outcome is tracked as unknown or confirmed as evidenced; deletion waits for reconciliation.

## 11. Witness and Anchor Protocol

### 11.1 Anchor contents

A Witness Anchor authenticates at minimum:

- Coordinator identity/epoch;
- journal revision and committed `commit_sequence`;
- journal hash-chain head or manifest root;
- deletion revision and tombstone-set commitment;
- key-generation ledger revision/commitment;
- manifest format/version and anchor request ID;
- witness monotonic version/receipt and freshness evidence.

The witness must not receive personal content. Whether the commitment scheme itself leaks linkable stable identifiers is part of the privacy evaluation.

### 11.2 Regions and consistency

- `ANCHORED_REGION`: events at or below the most recent validated anchor are externally evidenced under the agreed witness trust model.
- `UNANCHORED_REGION`: later locally committed events not yet covered by a validated anchor. They are not rollback-resistant.

A Consistency Token binds its referenced journal, scope, authorization, key, witness, and manifest revisions. A token is rejected if any binding is stale or mismatched.

### 11.3 Anchor lifecycle

1. Coordinator commits local event(s) and journal revision.
2. Anchor worker constructs a privacy-reviewed manifest over the journal head, deletion revision, and key-generation revision.
3. Witness receives the commitment; no multi-store transaction is assumed.
4. Coordinator validates authenticated witness response, monotonic version, exact manifest, and freshness.
5. Coordinator commits the anchor receipt reference and advances local anchored projection.
6. Any crash or ambiguity between steps 3-5 is resolved by querying/reconciling the witness; it is never assumed unanchored or anchored based only on local memory.

Anchoring a journal head externally does not mean every business operation represented by that head succeeded. It proves only the committed manifest/sequence according to the witness contract.

### 11.4 Failure

Missing, stale, contradictory, unverifiable, or unavailable witness proof blocks affected restore and deletion-finalization operations. Under the approved RPO policy, it also blocks new operations when the unanchored limits are reached. Before that policy is approved, default behavior for safety-critical deletion and restore remains fail-closed.

Witness choice, quorum/consistency semantics, authentication, retention, outage objective, and time/freshness model are BLOCKERS.

## 12. Witness-First Deletion State Machine

### 12.1 Deletion semantics

Deletion has distinct states: requested, locally blocked, tombstone prepared, witness anchored, key destruction pending/completed, cleanup pending/completed, verified, and completed. A request or local block is not deletion completion. Once a deletion tombstone is anchored, the deletion decision is irreversible; crashes cannot roll it back.

### 12.2 Deletion transition table

| Previous state | Trigger | Preconditions / authority | Required durable work | Next state | Failure behavior |
|---|---|---|---|---|---|
| `ACTIVE` | delete request | Authorized requester; exact opaque scope resolved through Protected Link Store | Atomic Coordinator commit of `DELETE_REQUESTED`, local admission barrier, fence increment, visibility close, revoke pending grants/leases/contexts | `DELETE_REQUESTED` / `LOCALLY_BLOCKED` | If commit uncertain, keep gate closed and recover from journal |
| `DELETE_REQUESTED` | enumerate affected artifacts | Mapping is available and authenticated; deletion scope fixed | Commit deletion manifest/revision; enumerate LTM, STM/WM, indexes, caches, staging, projections, temp files, backups, key refs | `TOMBSTONE_PREPARED` | Missing mapping => no guessed links; `RECOVERY_REQUIRED` |
| `TOMBSTONE_PREPARED` | anchor tombstone | Opaque tombstone and manifest validated; witness reachable and authenticated | Witness commits tombstone/deletion revision before key destruction | `TOMBSTONE_ANCHORED` | No proof => stay blocked; do not destroy keys and do not claim complete |
| `TOMBSTONE_ANCHORED` | destroy data keys | Witness anchor verified; exact key generations/objects enumerated | Commit key destruction/revocation evidence and irreversible generation floor | `KEYS_ERASED` or partial | Crash resumes forward only; never restore old key |
| `KEYS_ERASED` | cleanup replicas | Cleanup manifest complete; gate stays closed | Remove/invalidate projections, indexes, caches, leases, temporary/staged copies, and apply backup policy | `CLEANUP_PENDING` / `CLEANUP_VERIFIED` | Missing artifacts or evidence => remain pending/recovery |
| `CLEANUP_VERIFIED` | final deletion verification | Tombstone, witness, key ledger, deletion ledger, artifact inventory, backup policy all reconcile | Commit final verification and anchor deletion revision as policy requires | `DELETION_COMPLETED` | Any unknown/mismatch => `RECOVERY_REQUIRED`, no completion claim |
| Any pre-anchor state | retry/recovery | Same idempotency and manifest; no contradictory evidence | Resume same operation without duplicating tombstone identity | prior/forward state | Unknown witness outcome must be queried; never create conflicting tombstone |
| `TOMBSTONE_ANCHORED` or later | rollback/restore request | Any request to reopen or restore deleted content | Reject, quarantine stale image, apply tombstone | remains deleted/blocked | No transition back to active |
| Any | evidence/order conflict | Conflicting journal, witness, link, or generation evidence | Commit recovery marker if possible | `RECOVERY_REQUIRED` | Gate stays closed |

### 12.3 Immediate barrier and in-flight work

At the committed `DELETE_REQUESTED` point, local authorization, context release, visibility, caches, and leases for the scope are revoked/closed and the fence advances. This is immediate local protection, not external rollback protection. Pre-barrier operations already invoked at an Adapter may be in flight; their evidence must be reconciled and their possible disclosures documented before `DELETION_COMPLETED`.

### 12.4 Completion conditions

`DELETION_COMPLETED` is permitted only after:

- Coordinator event ordering and delete scope are proven;
- tombstone is externally anchored and verified;
- all relevant key generations are irreversibly revoked/destroyed under the approved key model;
- data copies, projections, search/relationship indexes, caches, leases, temporary files, and protected staging are cleaned or cryptographically inaccessible under a documented residual-retention policy;
- backup restore will reapply the deletion before any visibility;
- in-flight send/delivery operations are resolved to evidenced states or an explicit approved residual-risk state;
- Deletion Ledger, Key Generation Ledger, Witness, and Coordinator Journal agree.

If any condition is unknown, including an unresolved external send or delivery outcome, the state is not `DELETION_COMPLETED`. A separately named local-erasure verification may be recorded, but it must not be represented as system-wide deletion completion.

## 13. Tombstone and Key Erasure Protocol

### 13.1 Opaque tombstone

Tombstones use random opaque deletion/scope tokens and a minimal commitment to the affected deletion revision and key-generation floor. They must not carry names, plaintext keys, memory text, direct personal identifiers, or stable cross-context subject IDs unless a reviewed necessity and privacy assessment approves them. Stable cross-anchor linkability is minimized.

The encrypted Protected Link Store resolves an authorized deletion request to exact artifacts. A tombstone is created from this explicit resolution and manifest, not from heuristic similarity.

### 13.2 Order of operations

1. Commit delete request + local barrier + fence increment.
2. Freeze visibility, authorization, contexts, caches, and pending leases.
3. Resolve and freeze the exact deletion manifest using authenticated links.
4. Prepare opaque tombstone and commit its witness anchor.
5. Revoke/destroy relevant DEKs and invalidate KEK wraps/generations.
6. Purge or cryptographically invalidate derived data and copies; update backup/retention controls.
7. Verify inventory and ledger consistency; commit `DELETION_COMPLETED` only when all required conditions pass.

No key destruction before tombstone anchor. No visibility reopen at any stage after tombstone anchor.

### 13.3 Protected Link Store loss

If Protected Link Store is missing, corrupt, stale, or cannot authenticate:

- do not infer a subject-to-record mapping from text, similarity, timing, or neighboring tombstones;
- close the Visibility Gate for the affected scope and enter `RECOVERY_REQUIRED`;
- preserve the deletion request as unresolved;
- recover only from an authenticated current link-store backup reconciled against witness/key generations, or from an explicitly approved independent mapping source;
- if mapping cannot be proven, do not declare deletion complete.

### 13.4 Key generation floor

The key ledger maintains a monotonic minimum valid generation per scope and a permanent revoked/destroyed set. Restore must import the newest witnessed floor before any key unwrap. A historical receipt or backup containing a retired key cannot lower this floor. If floor integrity cannot be established, all affected keys remain inaccessible and recovery is required.

## 14. Rollback and Backup Restore Protection

### 14.1 Before and after witness anchoring

Before a witness anchor, only local transaction ordering/durability is available. The system cannot claim rollback resistance against a restored full image, copied database, or attacker with old local keys. Any unanchored deletion state is not externally protected.

After an authenticated current anchor is verified, older images can be detected by comparing their journal sequence/revision/hash, deletion revision, key-generation floor, and manifest to the witness. This guarantee depends on witness monotonicity and trust assumptions, which remain open.

### 14.2 Restore protocol

A restored image is quarantined with the Visibility Gate closed and egress disabled. It cannot serve memory or unwrap keys before these steps complete:

1. Verify boot/runtime identity and Coordinator integrity; start with no trusted local admission state.
2. Acquire current external witness state through authenticated, freshness-checked channel. If unavailable, remain `RECOVERY_REQUIRED`.
3. Compare restored Coordinator Journal hash/revision/`commit_sequence` with witness floor/head. An older image is stale; a contradictory or newer unanchored image is unresolved.
4. Acquire the newest trusted journal replica or recovery source. A witness hash alone cannot reconstruct missing event payloads; if current journal data is unavailable, remain blocked.
5. Load and validate latest Tombstones and Deletion Ledger against witness deletion revision.
6. Load and validate Key Generations and irreversible revocation floor; never accept a lower generation from the backup.
7. Validate Protected Link Store authentication and revision. If unavailable, do not reconstruct mappings heuristically.
8. Reconcile Coordinator Admission State from committed journal events; local snapshots are projections only.
9. Reconcile Pending Operations and Adapter Receipts; ambiguous effects remain `*_OUTCOME_UNKNOWN`.
10. Rebuild projections/indexes only from authorized surviving events, excluding deleted or revoked generations; invalidate stale caches/staging.
11. Validate RPO/anchor limits, trusted time where required, policy revisions, and manifest integrity.
12. Commit a recovery-complete event and fresh fence. Open only the minimum required gates after independent checks pass.

### 14.3 Reopen criteria

Visibility Gate may open only when Coordinator Journal, latest witness, tombstones, key generations, Deletion Ledger, Protected Link Store, pending operations, backup manifest, and projections are mutually consistent; no deletion is unresolved; and the active fence is newer than every restored worker/lease generation. Any unavailable proof keeps the gate closed.

An old image is never allowed to erase a newer tombstone, restore a key generation, resume a stale grant, or present a historical receipt as new authority.

## 15. Recovery and Crash Consistency

### 15.1 Deterministic recovery order and source of truth

| Order | Object checked | Authoritative source | Required action |
|---:|---|---|---|
| 1 | Visibility Gate / egress | Safety default + Coordinator | Close; disable delivery and key release before reconciliation |
| 2 | Coordinator Journal | Durable Coordinator store, integrity-checked | Find last committed sequence/hash; never infer missing commits |
| 3 | Witness | Authenticated external current head/floor | Validate sequence, journal revision, deletion revision, manifest, freshness |
| 4 | Tombstones | Witness-anchored Tombstone set + Deletion Ledger | Import newer tombstones; no rollback/removal from local backup |
| 5 | Key Generations | Key Generation Ledger reconciled to witness floor | Refuse revoked/older generations; isolate unknown keys |
| 6 | Deletion Ledger | Coordinator events cross-checked with witness/tombstone | Resume deletion forward; unknown means incomplete |
| 7 | Protected Link Store | Authenticated current revision | Use exact mappings only; loss means quarantine, no inference |
| 8 | Admission State | Rebuilt projection from Coordinator Journal | Ignore stale snapshot; apply current barrier and fence |
| 9 | Pending Operations | Coordinator records plus authenticated Adapter receipts | Resolve only with evidence; unknown remains unknown |
| 10 | Backups | Manifest, sequence, witness, deletion/key floors | Reject stale state or restore only through this protocol |
| 11 | Projections/caches/indexes/staging | Rebuild from authorized journal and surviving keys | Invalidate stale/deleted data and verify visibility filters |
| 12 | Gate reopening | Recovery authorization + all above checks | Commit recovery completion and new fence; open only proven-safe scope |

Witness and journal are independent evidence sources: witness establishes an externally anchored commitment, but does not replace event payloads or reconstruct missing local journal data. If either required source is missing, recovery stops.

### 15.2 Crash consistency rules

- A crash before local Coordinator commit means no committed transition; reread the journal and deduplicate by operation/idempotency key.
- A crash after commit means the committed state stands; resume only from that state after fence and token revalidation.
- A crash after Witness acceptance but before local receipt commit requires querying the Witness for the exact manifest/request ID. Do not create a conflicting anchor or assume failure.
- A crash after tombstone anchoring always resumes deletion forward. It never restores old content or keys.
- A crash between Adapter invocation and receipt commit means external outcome unknown absent authenticated reconciliation.
- A crash during cleanup leaves deletion pending; rerun idempotent cleanup and verify inventory, not completion by elapsed time.
- If journal order, sequence, hash, event causality, or witness state conflicts, enter `RECOVERY_REQUIRED`.

### 15.3 `RECOVERY_REQUIRED`

This is a fail-closed state, not a retry queue. It denies new egress, visibility of affected data, key unwrap, and deletion completion until an authorized recovery procedure documents evidence and commits a resolution. A manual override cannot manufacture missing external proof or roll back an anchored deletion.

### 15.4 Recovery state machine

Recovery is a distinct state machine. On startup after a crash or restore, the Visibility Gate defaults closed; the system does not first enter normal operation and then attempt validation.

| Previous state | Event | Preconditions / authority | Required durable commit | Next state | Failure behavior |
|---|---|---|---|---|---|
| `RUNNING` or unknown startup state | Crash recovery, restore, integrity alert, or ordering ambiguity | Gate can be closed locally; no trust is placed in restored Admission State | Commit recovery intent if Coordinator Journal is readable; otherwise retain closed gate without asserting a commit | `QUARANTINED` | If gate cannot be proven closed, halt affected service and require operator recovery |
| `QUARANTINED` | Verify journal | Current Coordinator store or authenticated recovery replica; valid hash/sequence chain | Record verified journal head and recovery checkpoint | `JOURNAL_VERIFIED` | Missing/corrupt journal => `RECOVERY_REQUIRED` |
| `JOURNAL_VERIFIED` | Verify witness | Authenticated witness response matches expected identity, freshness, sequence, and manifest | Commit witness reconciliation result | `WITNESS_VERIFIED` | Missing, stale, or contradictory witness => `RECOVERY_REQUIRED` |
| `WITNESS_VERIFIED` | Reconcile tombstones, deletion ledger, and key generations | Latest witnessed deletion/key revisions available; no generation rollback | Commit imported floors and deletion reconciliation checkpoint | `DELETION_AND_KEYS_RECONCILED` | Any missing mapping or mismatch => `RECOVERY_REQUIRED`; no key unwrap |
| `DELETION_AND_KEYS_RECONCILED` | Reconcile Protected Link Store and pending operations | Authenticated link-store revision; Adapter receipts validated; unknown outcomes retained | Commit link and operation reconciliation checkpoint | `LINKS_AND_OPERATIONS_RECONCILED` | Missing link/evidence or unresolved critical operation => `RECOVERY_REQUIRED` |
| `LINKS_AND_OPERATIONS_RECONCILED` | Rebuild projections and invalidate stale artifacts | Source journal and deletion filters verified; projection rebuild is reproducible | Commit projection manifest/digest and invalidation results | `PROJECTIONS_REBUILT` | Any deleted/stale item exposed or inventory incomplete => `RECOVERY_REQUIRED` |
| `PROJECTIONS_REBUILT` | Complete recovery | RPO/anchor policy, trusted-time requirements, policy revisions, and all prior checks pass; recovery authority approves | Commit recovery completion and a fresh Coordinator fence | `RECOVERY_COMMITTED` | Any failed gate remains `RECOVERY_REQUIRED` |
| `RECOVERY_COMMITTED` | Resume service | Committed Admission State proves no active delete barrier for requested scope | Commit/open only the minimum scope gate under the new fence | `RUNNING` | If deletion barrier is active, transition only to `DELETE_BARRIER_ACTIVE`; otherwise remain quarantined |
| Any recovery state | New inconsistency or evidence loss | Any actor detects conflicting/missing proof | Commit recovery failure event if journal integrity is established | `RECOVERY_REQUIRED` | Gate stays closed; no automatic bypass |
| `RECOVERY_REQUIRED` | Reattempt recovery | New authenticated evidence/source becomes available; authorized recovery procedure | Commit a new recovery attempt/checkpoint linked to prior attempt | `QUARANTINED` | Without new evidence, remain `RECOVERY_REQUIRED` |

`RECOVERY_REQUIRED` cannot transition directly to `RUNNING`. Every successful recovery re-enters through the ordered verification states and a fresh fence. `SEND_OUTCOME_UNKNOWN` and `DELIVERY_OUTCOME_UNKNOWN` remain unknown unless authenticated outcome evidence arrives; an unresolved external operation blocks `DELETION_COMPLETED`.

## 16. RPO and Anchor Policy

No numerical RPO, unanchored-event limit, or anchor interval is selected here. The available historical materials do not contain approved values. They require explicit product/system-owner approval before Phase B and before any policy is relied upon.

### 16.1 Required approved values

| Decision | Required definition | Status |
|---|---|---|
| RPO target | Maximum recoverable committed-data loss, expressed in approved units and scope | BLOCKER: value and owner approval missing |
| Max unanchored events | Maximum committed events beyond the last validated anchor | BLOCKER: value missing |
| Max anchor interval | Maximum elapsed time between anchors, using an approved trusted-time definition | BLOCKER: value missing |
| Witness outage policy | Which operations queue, block, or remain available during outage | BLOCKER: policy missing; safety-critical deletion/restore fail closed meanwhile |
| Re-entry criteria | Proof and stability checks required after outage/lag | BLOCKER: exact criteria missing |
| Anchor quorum/finality | Required witness acknowledgements and consistency semantics | BLOCKER: witness design missing |
| Recovery source | Durable source of event data if restored journal predates witness head | BLOCKER: replica/source not selected |

### 16.2 Default behavior until approval

- Never exceed a configured approved limit; if limits are not configured, do not claim an RPO guarantee.
- For deletion, restore, key release, and visibility, witness absence or unverifiable freshness remains fail-closed.
- When the eventual approved count or time threshold is exceeded, block new affected operations, mark the unanchored region unsafe, and require controlled reconciliation.
- No local-only state or elapsed-time assumption substitutes for an anchor.

## 17. Metadata Privacy Threat Model

### 17.1 Adversary model

At minimum assess:

- a local observer able to read a backup, database, logs, or file metadata but not encryption keys;
- a cloud/provider observer seeing request timing, payload size, destination, and repeated request patterns;
- a witness operator seeing anchor times, commitment sizes, cadence, and stable identifiers;
- a cross-source analyst correlating observed events with public or independently obtained timestamps;
- an attacker restoring old snapshots or comparing before/after system images;
- an insider with limited operational metadata access;
- compromise of one key domain while other independent domains remain protected.

Capabilities, collusion assumptions, access duration, auxiliary datasets, and whether active traffic analysis is in scope must be approved. The threat model does not assume that encryption hides event timing, size, frequency, or correlation.

### 17.2 Metadata at risk

- precise or coarse transaction/valid timestamps and their ordering;
- request/commit sequence gaps, event types, retry patterns, and recovery frequency;
- event count, payload/ciphertext size, memory class, key generation, and tombstone count;
- stable scope/object/operation identifiers across journal, witness, provider, backups, or deletion records;
- anchor cadence and relation to user activity or delete requests;
- destination/provider, route choice, timing, and response size;
- graph edges, source categories, confidence/importance values, and rare combinations;
- backup size deltas, cache/index artifacts, and cleanup timing.

### 17.3 Baseline requirements

Before collection/evaluation, freeze a baseline schema and versioned policy describing:

- every persisted/transmitted metadata field, its purpose, lifetime, access, and key domain;
- fields forbidden by default (direct personal identifiers, plaintext content, unnecessary precise time, stable cross-domain linkage IDs);
- permitted precision/retention transformations and justified exceptions;
- event batching/padding, identifier rotation, and anchor behavior if selected;
- baseline attacker auxiliary information and attack procedure.

Do not claim unlinkability solely from opaque IDs; timing and stable commitments can still correlate records.

## 18. Privacy Measurement and Acceptance Criteria

### 18.1 Measurements

A pre-registered evaluation must measure at least:

- top-1/top-k record or subject re-identification rate;
- pairwise linkage precision/recall and ROC-AUC against a defined chance/baseline model;
- uniqueness of metadata tuples and equivalence-class sizes;
- inference of event/delete timing (error distribution and success within approved time windows);
- linkage across journal, witness, provider, and backup views;
- information leakage from event counts, sizes, anchor timing, and tombstone patterns;
- before/after deletion residual linkage and recoverability from test backups;
- false-positive/false-negative rates for privacy filters and utility loss for approved retrieval.

The precise metrics must be appropriate to the approved adversary and data type. Synthetic data is required for design validation; no personal production data may be used in current phases.

### 18.2 Sample and confidence

No numeric sample size or confidence level is available in the prior documents or user-supplied decisions. They must not be invented. Before a test is authorized, the owner must approve:

- synthetic dataset size `N` and stratified scenario counts;
- independent evaluation split and repeated-run protocol;
- confidence level `C` and method for confidence intervals;
- minimum detectable effect/power where hypothesis testing is used;
- approved baseline and adversary auxiliary data;
- acceptance threshold `T_i` for each metric and handling of multiple comparisons.

Required design scenarios include rare/common events, different timestamps and cadence, multiple scopes, deletions before/after anchors, stale backups, provider and witness timing, identifier rotation, missing links, and recovery events. The values `N`, `C`, and `T_i` remain BLOCKERS until approved.

### 18.3 Acceptance and claims

For each risk metric, the preregistered upper confidence bound must meet its approved threshold; deletion recovery tests must show no forbidden data/key/link revival in the authorized synthetic corpus; and independent reproduction must match the specified procedure. Any failed metric blocks the privacy claim and triggers redesign/retest.

Until real results exist, status is **NOT MEASURED / NOT VALIDATED**. This document makes no claim that metadata privacy or unlinkability is achieved.

## 19. Memory Retrieval and Context Building

1. Determine task type, current authorization, data classification, and whether local-only policy applies.
2. Query only the required namespaces: personal LTM, task-scoped WM, eligible STM, and/or non-personal KB. Do not merge namespaces by default.
3. Filter deleted, expired, unauthorized, sensitive, invalid-time, low-provenance, or wrong-scope records before ranking.
4. Rank across semantic/lexical relevance, explicit graph relations, valid-time match, provenance, confidence, importance, and task constraints. Score weights and thresholds require calibration and approval.
5. Deduplicate and cap count, tokens/characters, and total context size under an explicit per-task budget.
6. Include source/provenance, transaction-time revision, valid-time interpretation, and epistemic label needed for truthful use.
7. Present retrieved values as data, not instructions. Do not claim prior knowledge when no supported record was retrieved.
8. Report context use/status without leaking memory contents into routing telemetry.
9. Never send the whole memory store by default. Cloud egress requires Section 22 authorization and payload binding.

Retrieval may return a candidate or abstain. It may not silently turn an inference/hypothesis into a fact. Relationship traversal must respect deletion, namespace, and authorization filters at every edge.

## 20. Sleep-time Consolidation

Sleep-time consolidation is a resumable, bounded local proposal/review process, not an automatic memory rewrite.

### 20.1 Work protocol

- Create a durable job record with opaque job ID, source event range/hash, algorithm/prompt version, privacy policy, checkpoint, and status.
- Use only eligible local events and authorized local models. No network/model call starts implicitly.
- Process bounded batches; checkpoint each completed batch with source commit range and deterministic output digest.
- Produce proposals: candidate facts, corrections, links, or decay/archive suggestions, each with provenance, evidence, uncertainty, temporal scope, and explanation.
- Keep proposals isolated from confirmed memory projections until explicit review/approval.
- On resume, verify source range, job version, deletion/tombstone revisions, key generations, and checkpoint digest. Discard/recompute stale proposals when inputs changed.
- Commit accepted proposals as new append-only memory events; never mutate prior history silently.
- Delete/cancel proposals and temporary context under deletion and retention policies.

### 20.2 Safety conditions

No automatic promotion of uncertain claims; no deletion based only on model suggestion; no cross-user learning; no sensitive data egress; no processing across a deletion barrier; and no resume from a checkpoint whose source revisions are stale or whose integrity cannot be checked.

## 21. Experience Learning and Skills Versioning

Learning from experience is a controlled pipeline:

1. Record approved, privacy-minimized outcome/evaluation signals with provenance and no unnecessary personal content.
2. Generate a candidate skill or update in an isolated version branch; capture source cases, assumptions, environment, and model/tool versions.
3. Evaluate on an approved synthetic/local benchmark with explicit pass, regression, safety, and privacy criteria.
4. Require authorized review before release. A candidate is not executable or trusted merely because it was generated.
5. Publish immutable version IDs with content digest, lineage, evaluator results, permissions, and rollback target.
6. Rollback changes the active pointer to a previously approved version; it does not rewrite historical records or restore revoked data/keys.
7. Deletion of source material must invalidate/rebuild dependent skill artifacts where derivation makes them in scope; dependency lineage is required to determine this.

Skill execution permissions, sandbox, evaluator thresholds, dependency tracking, and deletion propagation are open decisions. Until specified, skills remain untrusted proposals and are not enabled for autonomous execution.

## 22. Local/Cloud Privacy Routing

- Classify each request and selected context before routing. Sensitive data, classification uncertainty, or a local-only policy routes locally or is blocked; it never falls back to cloud.
- Retrieve only the minimum context and apply redaction/minimization before any external request.
- Obtain explicit policy/consent for provider, destination, data categories, and operation; bind the final payload to its authorization digest as in Section 10.
- Treat prompt, retrieved memories, response, route metadata, timing, and token/payload sizes as potential personal or linkable data.
- Provider Send and Result Delivery each receive separate authorization and audit trails. A response is not delivered just because it was generated.
- Do not expose secrets, credentials, direct identifiers, or unapproved memory to external providers.
- No automatic retries or provider fallback when the external outcome is unknown or policy is unresolved.
- Record minimized route metadata only under the metadata privacy baseline. Route telemetry must not include prompt or memory content.
- Provider selection, retention, data residency, training use, deletion capability, adapter receipt support, and contractual guarantees require explicit review before cloud routing is authorized.

## 23. Failure and Recovery Matrices

### 23.1 Coordinator / ordering

| Failure | Detection | Required state/action | Prohibited outcome |
|---|---|---|---|
| Coordinator unavailable | No authoritative transaction | Block new admissions and egress; recover from journal/witness | Local worker decides order |
| Transaction result ambiguous | Commit response lost | Re-read journal by idempotency/operation ID | Duplicate grant or assume rollback |
| Sequence/hash conflict | Integrity check mismatch | `RECOVERY_REQUIRED`; close gate | Continue with guessed order |
| Stale worker/fence | Generation mismatch | Reject grant and Adapter call | Refresh from stale cache |
| Delete/send race | Queue + commit order known | Earlier committed operation reconciled; later admission blocked | Timestamp-based winner or barrier check alone |

### 23.2 Send and delivery

| Failure | Required state | Retry policy | Completion claim |
|---|---|---|---|
| Before `*_STARTED` durable commit | Authorized or rejected per journal | May resume only if current grant remains valid | None |
| After `*_STARTED`, no receipt | `*_OUTCOME_UNKNOWN` | No automatic retry | None |
| Authenticated definitive rejection | `SEND_REJECTED` / `DELIVERY_REJECTED` | New operation only under new authorization | Rejected only within receipt semantics |
| Invalid/mismatched receipt | Unknown or recovery | Do not accept/replay | None |
| Idempotency conflict | Original unchanged + conflict record | Reject conflicting request | No new operation |
| Barrier after operation was sent | Reconcile in-flight operation; deletion remains pending | No new send/delivery | No deletion completion until conditions pass |

### 23.3 Witness, deletion, and restore

| Failure | Required state/action | Key/visibility rule |
|---|---|---|
| Witness unavailable before tombstone anchor | Keep delete blocked/pending; retry/reconcile exact request | Do not destroy keys or claim complete; visibility closed |
| Witness outcome ambiguous | Query witness for exact request/manifest | Do not mint conflicting tombstone; gate closed |
| Crash after tombstone anchor | Resume deletion forward | Never restore old key/data generation |
| Key destruction partial | `CLEANUP_PENDING` / recovery | Destroyed generations never reactivated; gate closed |
| Backup older than witness | Reject/quarantine and recover from current trusted source | Apply tombstones/key floor before reads |
| Witness newer but journal payload missing | `RECOVERY_REQUIRED`; obtain trusted journal replica | Do not reconstruct from hash or open gate |
| Protected Link Store lost | Quarantine; recover authenticated revision only | No heuristic mapping; deletion unresolved |
| Projection/index stale | Rebuild from committed surviving events | Filter tombstones before exposure |
| Trusted time unavailable | Disable time-dependent lease/expiry decisions | Do not extend lease or infer freshness |
| RPO/anchor threshold exceeded | Block affected work; controlled reconciliation | No local-only override |

## 24. Guarantees, Assumptions and Open Decisions

### 24.1 Design invariants specified here

- One Coordinator authority orders committed state; requests and commits are distinct sequences.
- Admission State is a transactionally updated projection, not a second authority.
- Send and delivery are independent, payload-bound operations with separate state machines.
- Unknown outcomes stay unknown absent authenticated reconciliation; no automatic retry.
- A local barrier blocks new admissions at its commit point; pre-barrier external work may remain in flight and must be reconciled.
- A witness-anchored tombstone is irreversible; deletion continues forward after crash.
- Restore remains quarantined until the journal, witness, tombstones, key generations, deletion ledger, link store, pending operations, and visibility checks agree.
- Bitemporal boundaries are typed; unknowns are not guessed; memory changes remain historically traceable.
- Consolidation and skills are proposals until reviewed, versioned, and approved.
- Metadata privacy is a threat and a measurement obligation, not a demonstrated property.

These are architectural rules, not implementation evidence.

### 24.2 Assumptions

- A Coordinator store can provide the required atomic transaction and durable monotonic sequence.
- A current, authenticated journal source can be recovered when a local backup is stale.
- A Witness can provide authenticated monotonic anchoring and deletion evidence.
- Key stores can enforce irreversible generation revocation across restore.
- Adapters can provide sufficiently authenticated receipts or unknown outcomes can be safely retained.
- Trusted time can be made available for any time-based lease/expiry behavior.
- Artifact enumeration and deletion dependencies can be made complete, including caches, indexes, staging, and backups.

Each assumption needs technical evidence before implementation readiness.

### 24.3 Open decisions

- Witness provider, trust anchors, quorum/finality, freshness, retention, and outage SLA.
- Coordinator storage/consistency model, durability settings, single-writer/queue deployment, disaster recovery and fencing persistence.
- RPO, maximum unanchored event count, anchor interval, outage behavior, and re-entry criteria.
- Approved AEAD/MAC/KDF suite, nonce design, key custody, rotation, escrow prohibition/exception, and cryptographic-erasure evidence.
- Trusted time source and lease duration/clock rollback policy.
- Provider/receiver receipt semantics, idempotency support, and handling of permanently unknown effects.
- Tombstone payload/retention, backup lifecycle, physical-erasure scope, and residual retention policy.
- Metadata privacy baseline fields, attacker scope, dataset size, confidence, thresholds, and test procedure.
- Temporal/confidence/importance scales, retrieval scoring, context budgets, and epistemic promotion rules.
- Consolidation approval workflow and skill sandbox/evaluator/deletion lineage.
- User consent model, cloud provider contracts, data residency/retention, and routing policy.

## 25. Implementation Blockers and Readiness Gates

No implementation or Phase A/B may begin until all applicable blockers are resolved, documented, and explicitly approved. This document itself grants no authorization.

### 25.1 Blocking list

- **BLOCKER-01 Historical source gap:** v1.0-v3.3 primary documents and per-release decision logs were not found. Exact release attribution and original wording cannot be independently verified.
- **BLOCKER-02 Coordinator atomicity proof:** choose and prove a durable transaction/queue/fencing implementation meeting Section 7; demonstrate crash behavior and stale-worker rejection without distributed atomic transaction assumptions.
- **BLOCKER-03 Coordinator disaster recovery:** identify authoritative journal replica and restore/reconciliation method; a witness hash alone cannot reconstruct absent events.
- **BLOCKER-04 Witness trust and service:** select witness and define authentication, monotonicity, quorum/finality, retention, freshness, outage, and recovery semantics.
- **BLOCKER-05 RPO/anchor values:** approve RPO, max unanchored events, anchor cadence, outage policy, and re-entry criteria; no arbitrary values have been selected.
- **BLOCKER-06 Cryptographic profile:** approve algorithms, key sizes, nonce uniqueness strategy, key custody, generation ledger, rotation, and erasure evidence.
- **BLOCKER-07 Adapter contract:** define signed/authenticated receipts, handoff semantics, idempotency, lookup/reconciliation, and acceptable permanent-unknown behavior for every send/delivery adapter.
- **BLOCKER-08 Deletion completeness:** prove artifact/backup inventory and link-store recovery; define treatment of provider-retained copies, immutable backups, and physical media.
- **BLOCKER-09 Restore gate:** demonstrate the ordered checks and prove no gate opens before current witness/tombstone/key/deletion/link/pending-operation reconciliation.
- **BLOCKER-10 Trusted time and leases:** choose trusted time source, rollback detection, and expiry/fencing policy; otherwise disable time-dependent authorization.
- **BLOCKER-11 Metadata privacy thresholds:** approve adversary model, baseline, synthetic sample size `N`, confidence `C`, acceptance thresholds `T_i`, analysis procedure, and reproducibility plan.
- **BLOCKER-12 Memory data policy:** approve valid-time representation, confidence/importance scales, provenance standards, retention, and correction/deletion semantics.
- **BLOCKER-13 Consolidation and skill governance:** approve local processing limits, resumability/checkpoint integrity, human review, evaluation thresholds, sandbox, and deletion lineage.
- **BLOCKER-14 Cloud routing/consent:** approve providers, data categories, consent, retention, locality, and response-delivery policy before external memory context is permitted.
- **BLOCKER-15 Independent design review:** threat model, state-machine cross-check, cryptographic review, privacy review, and operational recovery review must sign off before any readiness gate.

### 25.2 Readiness gates

- **Gate 0 - Design review:** current status. No implementation/testing/simulation permission.
- **Gate 1 - Decisions approved:** close relevant blockers with named decision owner and written values/contracts.
- **Gate 2 - Implementation authorization:** separate explicit authorization after Gate 1; still no Phase A/B unless separately approved.
- **Gate 3 - Phase A authorization:** requires agreed synthetic-only scope, safety controls, test plan, and explicit user approval. Currently NOT AUTHORIZED.
- **Gate 4 - Phase B authorization:** requires Gate 3 evidence, RPO/witness/privacy thresholds, recovery drills approval, and explicit user approval. Currently BLOCKED.

## 26. Historical Decision Traceability Matrix

### 26.1 Evidence labels

- **V3.4 verified:** directly present in the only architecture document found in the project.
- **User-supplied history:** explicitly supplied in the current request as a historical decision, but no original release artifact was available to verify wording or first version.
- **Unavailable:** no primary source/revision was located; do not infer an approved historical detail.
- **Preserved:** carried into the corresponding v3.5 section as a normative design requirement.
- **Expanded proposal:** operational mechanism added here to make the requirement testable; it is not claimed to have been an approved past implementation choice.

The only project architecture document found is `docs/jarvis-memory-architecture-v3.4.md`. It contains no release-by-release changelog or evidence for v1.0-v3.3. The Git history available during this review did not return verifiable document revisions. Therefore all exact first-release values below are marked unavailable unless directly stated in v3.4; user-supplied historical decisions are not falsely attributed to a version.

### 26.2 Traceability table

| Original decision | Version added | v3.5 destination | Preserved? | Changed? | Reason for change/expansion | User approval needed? | Supporting reference |
|---|---|---|---|---|---|---|---|
| Separate STM, LTM, and WM | Unavailable; user-supplied history | Sections 3, 4, 19 | Yes | Operational lifecycle detailed | Make boundaries and retrieval scopes explicit | Yes, retention/limits | User-supplied history; original v1.0-v3.3 docs unavailable |
| Separate non-personal Knowledge Base from personal memory | Unavailable; user-supplied history | Sections 3, 4, 19 | Yes | Namespace/key boundary specified as proposal | Prevent accidental context or deletion crossover | Yes, namespace and policy | User-supplied history; original release unavailable |
| Build small task-specific context; never send all memory | Unavailable; user-supplied history | Sections 2, 19, 22 | Yes | Adds filtering/budget steps | Make minimization actionable | Yes, budgets and scoring | User-supplied history; v3.4 README is not treated as original architecture evidence |
| Multi-dimensional retrieval and relationships | Unavailable; user-supplied history | Sections 4.5, 19 | Yes | Score calibration left open | Avoid asserting uncalibrated ranking | Yes, weights/thresholds | User-supplied history; source version unavailable |
| Retain source, date, confidence, importance | Unavailable; user-supplied history | Sections 4.2-4.4 | Yes | Time semantics made bitemporal | Preserve provenance and temporal meaning | Yes, confidence/importance scales | User-supplied history; source version unavailable |
| Distinguish fact, inference, hypothesis | Unavailable; user-supplied history | Sections 4.2, 19, 20 | Yes | Explicit epistemic labels | Prevent unsupported promotion | Yes, promotion policy | User-supplied history; source version unavailable |
| Historical changes; no silent deletion/overwrite | Unavailable; user-supplied history | Sections 2, 4, 5 | Yes | Append-only event/projection model specified | Make history/rebuild semantics explicit | Yes, legal retention exceptions | User-supplied history; v3.4 supports no silent inference only generally |
| Resumable sleep-time consolidation | Unavailable; user-supplied history | Section 20 | Yes | Adds job/checkpoint protocol proposal | Define deterministic resume and stale checkpoint behavior | Yes, checkpoint/privacy policy | User-supplied history; source version unavailable |
| Learning from experience; testable/reversible skills | Unavailable; user-supplied history | Sections 3, 21 | Yes | Adds version registry/review proposal | Make rollback and approval explicit | Yes, sandbox/evaluator | User-supplied history; source version unavailable |
| Bitemporal transaction/valid time | Unavailable; user-supplied history | Section 4.3 | Yes | Full semantics specified | Avoid ambiguous timestamps | Yes, serialization/time source | User-supplied history; source version unavailable |
| Half-open intervals `[valid_from, valid_until)` | Unavailable; user-supplied history | Section 4.3 | Yes | None | Retain exact interval convention | No new semantic change; representation needs approval | User-supplied history; source version unavailable |
| UNKNOWN / OPEN / UNBOUNDED distinct | Unavailable; user-supplied history | Section 4.3 | Yes | Typed meanings made explicit | Prevent sentinel conflation | Yes, schema/API mapping | User-supplied history; source version unavailable |
| Never guess unknown temporal bounds | Unavailable; user-supplied history | Sections 2, 4.3 | Yes | None | Fail-closed temporal interpretation | No, implementation details remain open | User-supplied history; source version unavailable |
| Append-only Event Log + Current Projection | Unavailable; user-supplied history | Sections 3, 5 | Yes | Projection transaction boundary clarified | Make event/projection roles explicit | Yes, storage transaction design | User-supplied history; source version unavailable |
| Single ordering source | Exact release unavailable; v3.4 confirms | Sections 2, 5, 7 | Yes | Stronger scope defined as Coordinator | Remove ambiguity about competing logs | Yes, deployment/partitioning | v3.4 Sections 2, 3, 4; historical first version unavailable |
| Knowledge-at-the-time vs best-current historical understanding | Unavailable; user-supplied history | Section 4.4 | Yes | Query semantics made explicit | Avoid temporal hindsight leakage | Yes, API semantics | User-supplied history; source version unavailable |
| Envelope encryption | Unavailable; user-supplied history | Section 6.1 | Yes | Technology intentionally unselected | No approved crypto profile available | Yes, crypto profile BLOCKER | User-supplied history; original version unavailable |
| Separate content encryption and Audit MAC | Unavailable; user-supplied history | Sections 6.1, 6.3 | Yes | Adds canonical audit binding proposal | Prevent key/purpose reuse and clarify proof limits | Yes, algorithm/key custody | User-supplied history; source version unavailable |
| Independent keys for data, link, and audit domains | Unavailable; user-supplied history | Sections 3, 6 | Yes | Domain responsibilities expanded | Reduce cross-domain compromise | Yes, key derivation/custody | User-supplied history; source version unavailable |
| AEAD with controlled Nonce and AAD | Unavailable; user-supplied history | Section 6.2 | Yes | Explicit non-reuse and binding requirements | Define safety criteria without selecting an unapproved suite | Yes, algorithm and nonce design BLOCKER | User-supplied history; source version unavailable |
| Deletion Ledger and opaque tombstone | Unavailable; v3.4 confirms tombstone concept | Sections 3, 12, 13 | Yes | Opaque format and lifecycle expanded | Make deletion evidence and privacy scope explicit | Yes, retention/manifest | v3.4 Sections 2, 3, 5, 8; original version unavailable |
| Old key generations never reactivated | Unavailable; v3.4 confirms generation safety | Sections 2, 6, 13, 14 | Yes | Adds generation floor | Make restore behavior explicit | Yes, ledger/anchor implementation | v3.4 Sections 2, 3, 5; original version unavailable |
| Clean projections, indexes, caches, temp files, backups | Unavailable; user-supplied history | Sections 12-15 | Yes | Adds inventory/verification requirements | Prevent residual visibility and false completion | Yes, retention and backup contract | User-supplied history; source version unavailable |
| Minimize metadata and personal linkage | Unavailable; v3.4 confirms risk | Sections 2, 17, 18 | Yes | Adds threat model and metrics; no claim | Turn general principle into measurable blocker | Yes, privacy baseline/thresholds BLOCKER | v3.4 Sections 2, 7; source version unavailable |
| Backup restore applies deletion before visibility | Unavailable; v3.4 confirms stale restore rejection | Sections 14, 15, 23 | Yes | Adds deterministic restore order | Prevent stale image reopening | Yes, recovery source and proof BLOCKER | v3.4 Section 5; source version unavailable |
| Coordinator Journal sole committed order source | Exact release unavailable; v3.4 confirms | Sections 2, 5, 7 | Yes | Single transactional boundary proposed | Resolve vague v3.4 admission transaction | Yes, store technology and atomicity proof BLOCKER | v3.4 Sections 2-4 |
| `commit_sequence` monotonic, never reused | Unavailable; user-supplied history | Sections 2, 5, 7 | Yes | Clarifies gaps allowed, reuse forbidden | Specify crash-safe sequence behavior | Yes, storage proof | User-supplied history; source version unavailable |
| Separate `request_sequence` and `commit_sequence` | Unavailable; user-supplied history | Sections 2, 5, 7 | Yes | Request sequence is ingress arbitration only | Avoid treating queued request as commit | Yes, queue implementation | User-supplied history; source version unavailable |
| Admission State separate from ordering authority | v3.4 confirms | Sections 3, 5, 7 | Yes | Projection updated atomically with journal | Preserve distinction without a second order | Yes, database transaction capability BLOCKER | v3.4 Sections 3-4 |
| Lease, Fencing Token, Generation | Unavailable; user-supplied history | Sections 3, 7 | Yes | Stale worker checks formalized | Prevent old worker authorization after barrier | Yes, persistence/expiry model BLOCKER | User-supplied history; source version unavailable |
| Consistency Token binds state/scope/permissions/keys/witness/manifest | Unavailable; user-supplied history | Section 3.3 | Yes | Required fields enumerated as proposal | Make token validation auditable | Yes, signing/expiry model | User-supplied history; source version unavailable |
| Witness Anchor binds journal, commit, deletion revisions | Unavailable; v3.4 confirms witness anchor generally | Section 11 | Yes | Manifest fields expanded | Clarify externally anchored commitment | Yes, witness contract BLOCKER | v3.4 Sections 3, 5, 6; historical version unavailable |
| ANCHORED_REGION / UNANCHORED_REGION | Unavailable; user-supplied history | Section 11.2 | Yes | Defined as evidence boundary | Avoid treating local events as anchored | Yes, anchor cadence/RPO BLOCKER | User-supplied history; source version unavailable |
| Fail closed for lost Coordinator/Witness/time/integrity | Exact version unavailable; v3.4 confirms some | Sections 2, 7, 11, 14-16 | Yes | Failure-specific behavior expanded | Operationalize fail-closed requirements | Yes, time/witness dependencies | v3.4 Sections 1, 5, 6; user-supplied history |
| Separate Provider Send and Result Delivery | Exact version unavailable; v3.4 confirms separation | Sections 2, 3, 8-10 | Yes | Two independent complete state machines | Preserve distinction and add operational detail | Yes, adapter/receipt contract BLOCKER | v3.4 Sections 1-3; source version unavailable |
| `SEND_AUTHORIZED`, `SEND_STARTED`, `SEND_CONFIRMED`, `SEND_REJECTED`, `SEND_OUTCOME_UNKNOWN` | Unavailable; user-supplied history | Section 8 | Yes | Full transition conditions added | No state omitted; unknown remains nonterminal/manual | Yes, receipt semantics | User-supplied history; no original state-machine source |
| `DELIVERY_AUTHORIZED`, `DELIVERY_STARTED`, `HANDOFF_CONFIRMED` | Unavailable; user-supplied history | Section 9 | Yes | Adds explicit rejected/unknown states for completeness | Prevent success inference on failure | Yes, receiver semantics | User-supplied history; source version unavailable |
| No automatic retry on unknown outcome | Unavailable; user-supplied history | Sections 2, 8, 9, 23 | Yes | Explicit evidence-based reconciliation only | Prevent duplicate external effects | Yes, provider reconciliation contract | User-supplied history; source version unavailable |
| Approval bound to final payload | Unavailable; user-supplied history | Sections 8, 10 | Yes | Canonicalization/digest binding specified | Ensure authorization covers actual bytes | Yes, canonical format/approval UX | User-supplied history; source version unavailable |
| Protected Egress Staging Store | Unavailable; user-supplied history | Sections 3, 10, 12 | Yes | Added encryption/deletion requirements | Protect exact approved payload | Yes, retention/backup controls | User-supplied history; source version unavailable |
| Adapter Receipt validation | Unavailable; user-supplied history | Sections 8, 9, 23 | Yes | Receipt semantics and limits stated | Receipt proves only its contract | Yes, per-adapter contract BLOCKER | User-supplied history; source version unavailable |
| Independent audit keys, canonical record, Operation MAC | Unavailable; user-supplied history | Section 6.3 | Yes | Binding fields described | Separate integrity proof from provider truth | Yes, crypto profile BLOCKER | User-supplied history; source version unavailable |
| Idempotency Conflict | Unavailable; user-supplied history | Sections 8-10 | Yes | Conflict is immutable audited event | Prevent key reuse with changed payload | Yes, idempotency retention | User-supplied history; source version unavailable |
| STARTED is not proof of send/delivery | Exact release unavailable; v3.4 confirms | Sections 2, 8, 9 | Yes | None; clarified stage semantics | Prevent false success | No policy weakening; evidence contract open | v3.4 Sections 2-3 |
| Witness-First Deletion | Exact release unavailable; v3.4 confirms | Sections 12-14 | Yes | Full lifecycle and crash continuation added | Specify irreversible point and order | Yes, witness contract BLOCKER | v3.4 Sections 2, 5 |
| Local block immediately on delete request | User-supplied history; v3.4 barrier is partial | Sections 7, 12 | Yes | Bound to durable barrier commit | Avoid claiming local check is atomic | Yes, transaction proof BLOCKER | v3.4 Section 4; user-supplied history |
| Close visibility/revoke contexts, caches, leases | User-supplied history; v3.4 partial | Sections 12-15 | Yes | Enumerated components | Make immediate block comprehensive | Yes, inventory completeness | v3.4 Sections 3, 5; user-supplied history |
| Anchor opaque tombstone before key destruction | Unavailable; user-supplied history | Sections 12-13 | Yes | Exact ordered protocol defined | Preserve witness-first property | Yes, witness/key contracts | User-supplied history; source version unavailable |
| No `DELETION_COMPLETED` before proof | User-supplied history; v3.4 says delete not final | Sections 12, 13, 23 | Yes | Completion checklist added | Prevent status-only completion | Yes, residual policy | v3.4 Sections 2, 5; user-supplied history |
| Crash after anchor cannot roll back deletion | Unavailable; v3.4 witness-first principle | Sections 12-15 | Yes | Forward-only recovery explicit | Preserve irreversible tombstone | Yes, backup/key ledger proof | v3.4 Section 5; source version unavailable |
| Lost Protected Link Store means no guessed links | Unavailable; user-supplied history | Sections 13, 14, 15, 23 | Yes | Quarantine/manual recovery specified | Prevent false deletion scope | Yes, independent recovery source | User-supplied history; source version unavailable |
| Unprovable ordering -> `RECOVERY_REQUIRED` | Exact release unavailable; v3.4 confirms | Sections 2, 7, 14, 15, 23 | Yes | Recovery source/order made explicit | Keep uncertainty fail-closed | Yes, recovery authority | v3.4 Sections 2, 4, 8 |
| No old backup opens gate before current tombstone/witness/key checks | Exact release unavailable; v3.4 confirms | Sections 14-15 | Yes | Adds journal/link/pending-operation checks | Close gaps in restore prerequisites | Yes, restore proof BLOCKER | v3.4 Section 5 |
| Atomic admission barrier vs send/delivery | At least v3.3 per supplied session summary; original version document unavailable | Sections 7, 8, 9, 12 | Yes | Linearization and pre-barrier in-flight limit specified | Prevent race without fictional distributed transaction | Yes, Coordinator/Adapter proof BLOCKER | Supplied session summary; v3.4 Section 4 |
| Barrier is not second ordering authority; check alone insufficient | v3.4 | Sections 2, 5, 7 | Yes | Admission State made journal projection | Preserve one authority | No semantic change; implementation proof required | v3.4 Section 4 |
| No Adapter before durable appropriate authorization | User-supplied history | Sections 7-10 | Yes | Invocation requires committed start marker and fresh fence | Tie local authorization to external boundary | Yes, Adapter contract | User-supplied history; source version unavailable |
| Unknown ordering blocks and requires recovery | v3.4 | Sections 2, 7, 14-15, 23 | Yes | Applies across all state machines | Maintain fail-closed behavior | No policy relaxation | v3.4 Sections 2, 4, 8 |
| RPO, unanchored-event limit, anchor interval need owner decision | v3.4 | Sections 16, 25 | Yes | Expanded into explicit decision table | v3.4 deliberately left values open | Yes, BLOCKER | v3.4 Sections 6, 10 |
| Metadata privacy metrics/thresholds require empirical evidence | v3.4 | Sections 17-18, 25 | Yes | Adds adversary and measurement protocol; values remain open | No arbitrary numbers or false privacy claims | Yes, BLOCKER | v3.4 Sections 7, 10 |

### 26.3 Traceability conclusion

No decision in the supplied historical list has been intentionally removed. Because the v1.0-v3.3 source documents are unavailable, “preserved” means included from the user-supplied consolidated history, not independently authenticated against original release text. Any difference between this table and an original historical document must be treated as a possible `REGRESSION` until reviewed; it must not be silently resolved in favor of v3.5.

## Final status

v3.5 is a consolidated, self-contained design proposal with explicit state machines, transaction boundaries, recovery ordering, and traceability. It is **not implementation-ready as an approved specification**: core technology choices, external contracts, recovery sources, numeric RPO/privacy thresholds, and independent proofs remain blockers. Phase A and Phase B remain unauthorized. No tests, simulations, code changes, database changes, or external service calls are authorized by this document.
