# Jarvis Memory Architecture v3.6.1

Status: Architectural Consistency Correction — Not Approved for Implementation

Date: 2026-11-03
Reviewed baseline: `docs/jarvis-memory-architecture-v3.6.md`

## Document Status and Applicability

This document is a narrowly scoped correction of five consistency issues in v3.6. It is not a full republication of v3.6. All v3.6 provisions remain incorporated by reference except where one of the five corrections below explicitly supersedes them. No reader may infer or repair text damaged in the v3.6 source. In a conflict, the applicable correction in this document governs only its named topic; all other provisions remain unchanged.

This document creates no implementation, test, simulation, deletion, encryption, migration, external-service, Phase A, or Phase B authorization. It is not evidence that any security or privacy property has been implemented or validated. No cryptographic construction, numeric retention period, RPO value, or storage technology is selected here.

### Evidence and decision labels

- **Preserved:** directly retained from an available architecture document or user-provided historical decision.
- **Modified:** a source rule is narrowed or clarified to resolve a contradiction; the reason is stated.
- **Proposed:** a design mechanism introduced here; it is not an approved implementation choice.
- **Unresolved:** available evidence is insufficient to establish the rule or value; it remains a blocker.

## 1. Consolidation Privacy Consistency

### 1.1 Assessment of source ranges and digests

The v3.6 Consolidation section calls for persisting a `source journal range/hash`, a source commit range, a checkpoint, and a deterministic output digest. It does not specify their storage, access controls, or retention. These values must not be presumed non-personal:

| Value | Potential disclosure/linkage | Decision |
|---|---|---|
| `source journal range` / commit range | Can reveal that a job used a bounded set of events; sequence/time correlation may link it to personal activity even if the range contains no text | Treat as sensitive, linkable metadata |
| Source journal hash/checkpoint hash | Depending on input and construction, can reveal equality or support correlation with known events; a digest does not anonymize its input | Treat as a content-derived sensitive commitment unless disproven for the selected construction |
| Deterministic output digest | Can reveal equality across jobs or enable guessing of low-entropy output; deterministic form makes repeated output correlation easier | Treat as personal-content-derived and linkable by default |
| Job ID and proposal ID | Stable identifiers can link progress, output, reviewer activity, and source records | Use only as protected, purpose-limited references; opacity alone is not anonymization |

This assessment is conservative: v3.6 does not provide enough detail to prove that every value contains personal information, nor enough to prove that any of them is non-linkable. The exact input format, hash/commitment function, and stored representation are **Unresolved**.

### 1.2 Storage and access rule

**Proposed correction:** source ranges, source hashes, checkpoints, deterministic output digests, and mappings from those values to a proposal/job are stored only in a logically separate, access-controlled Consolidation Job Metadata Store. They must not be written in plaintext or as directly comparable content fingerprints to:

- the canonical Coordinator Journal or Memory Event Log;
- Witness manifests or anchor requests;
- general audit, diagnostic, telemetry, or application logs;
- unprotected projection records or backup manifests.

The protected store may be a logical boundary within a later approved storage design; this document does not select a database or physical storage technology. At rest it must use an approved protected key domain distinct from personal content and public audit integrity keys. The cryptographic construction and key lifecycle are **Unresolved** and must be approved before durable consolidation checkpoints are enabled.

Proposed least-privilege access:

- Consolidation Worker: read/write only the active job metadata required to resume that job.
- Coordinator: authorize the job and validate its state, without general access to personal output digests.
- Human reviewer: access the proposal and necessary provenance through a reviewed interface; source range/hash and output digest are hidden unless specifically necessary and authorized.
- Recovery/security operator: time-limited, audited access only for a documented recovery purpose.
- Witness and general log consumers: no direct access to these values.

These roles are a proposal, not proof that existing infrastructure enforces them. An opaque job identifier or encrypted field is not itself proof against timing, size, or cross-system correlation.

### 1.3 Retention and deletion

No numeric retention period is approved in v3.6 or this correction. The owner must define retention for active checkpoints, completed/rejected proposals, and recovery evidence. Proposed minimum-lifetime rule: retain protected source ranges and integrity checkpoints only while needed to resume/review the active job; once the job is terminal and required review is complete, remove or cryptographically invalidate the content-derived range/hash/output digest and its person/object mapping, retaining only a minimized non-content job outcome if policy requires it.

The precise terminal states, review-retention interval, legal/operational exceptions, deletion evidence, and backup expiry are **Unresolved**. Until approved, persistent consolidation requiring these metadata values is blocked. No public log or Witness entry may preserve a payload-derived digest as a substitute for this missing policy.

### 1.4 Digest use constraint

A plain hash is not encryption, anonymization, or unlinkability. A keyed commitment may also be linkable if its key or input is reused. If checkpoint integrity needs a deterministic digest, its protected construction, per-job keying, access, and destruction must be separately reviewed and approved. No digest is emitted to public journal/audit/Witness surfaces. If confidentiality and unlinkability cannot be established for the chosen design, the digest remains **Unresolved** and must not be persisted outside the protected job store.

Classification: prior resumable-consolidation requirement **Preserved**; protected metadata boundary and least-privilege pattern **Proposed**; actual sensitivity of each value, cryptographic design, and retention duration **Unresolved**.

## 2. Retrieval Filtering Rules

This section replaces only the overly broad retrieval filtering language in v3.6 Section 18. Authorization, namespace separation, task scope, deletion filtering, bounded context, and no-full-memory behavior remain **Preserved**.

### 2.1 Sensitivity is not authorization

A record is not excluded from local retrieval solely because it is marked sensitive. The retrieval decision must first evaluate purpose, user/agent authorization, scope, task, and current deletion/visibility state.

- Authorized local use: a sensitive record may be retrieved into a local-only context when the task and permission allow it.
- External use: a sensitive record is not eligible for provider egress unless a separately approved policy and authorization explicitly permit that category and bind the final payload. If policy forbids it or classification is uncertain, route locally or block; do not fall back to cloud.
- Unauthorized, wrong-scope, deleted, or currently hidden record: exclude regardless of sensitivity or temporal status.

Sensitivity filtering for external egress must not be confused with relevance filtering for local retrieval.

### 2.2 Temporal eligibility categories

| Temporal classification | Meaning | Retrieval treatment |
|---|---|---|
| `TIME_VALID_FOR_TASK` | Known temporal assertions satisfy the requested task interval/point | Eligible for ranking, subject to authorization and other filters |
| `TIME_INVALID_FOR_TASK` | Known valid-time interval is disjoint from the requested interval, or the record is explicitly contradicted/invalid under the domain rules | Do not use as a supporting answer for that temporal query; preserve it for appropriate historical queries if not deleted |
| `TIME_NOT_APPLICABLE` | The task does not depend on valid time, or the record's domain has no time condition | Do not exclude merely for lacking a date; rank under non-temporal relevance and provenance |
| `TIME_REQUIRED_BUT_UNKNOWN` | The task needs temporal qualification but required boundaries or temporal evidence are unknown/missing | Do not use it to answer the temporal part; mark the temporal evidence insufficient and abstain or request clarification |
| `TIME_BOUNDARY_OPEN_OR_UNBOUNDED` | The boundary is explicitly typed `OPEN` or `UNBOUNDED` | Apply that declared meaning only; do not coerce it to a guessed date or to `UNKNOWN` |

A known interval outside a requested time is different from a timeless record and from a record missing time information required by the task. `UNKNOWN`, `OPEN`, `UNBOUNDED`, and finite boundaries retain their v3.6 semantics. No missing date, source time, or interval is inferred from neighboring records, recency, or model knowledge.

### 2.3 Ordered retrieval decision

1. Apply deletion tombstones, visibility gate, user permissions, namespace, and task-scope checks.
2. Determine whether the task actually requires valid-time evidence.
3. Classify temporal eligibility using Section 2.2; do not treat absent time as invalid when time is not required.
4. Apply sensitivity policy for the intended execution location. Local authorization and external egress are distinct decisions.
5. Rank only eligible records using relevance, provenance, confidence, importance, and explicit sourced relationships; otherwise abstain or return an insufficiency state.
6. Before external routing, independently re-filter and minimize the final context and obtain payload-bound authorization under v3.6 Sections 10 and 21.

Classification: bounded task-specific retrieval and access scoping **Preserved**; sensitivity-based blanket exclusion **Modified**; detailed taxonomy/implementation of task policy and temporal classifier **Proposed**; ambiguous records remain **Unresolved** rather than guessed.

## 3. Adapter and External Send Evidence Boundaries

This section clarifies v3.6 Sections 7-9 and 22. It does not assume a distributed transaction or that a local event proves an external event.

### 3.1 Four separately evidenced stages

| Stage | Example evidence state | What it may establish | What it does not establish |
|---|---|---|---|
| Local Adapter function entry | `ADAPTER_INVOCATION_OBSERVED` | The local Gate observed entry into the Adapter method, if that event was durably recorded and its source is trusted | That a network operation began, bytes left the host, or a peer received anything |
| Local network request initiation | `NETWORK_REQUEST_INITIATION_OBSERVED` (proposed) | The local transport/API reported beginning a request operation | That packets/bytes left the device, reached a network interface, or reached the remote service |
| External arrival/receipt | `REMOTE_RECEIPT_CONFIRMED` (only when supported by an authenticated receipt) | The external endpoint/adapter receipt claims receipt under its defined contract | Acceptance, processing, execution, persistence, or user delivery unless the receipt contract explicitly proves it |
| External acceptance/effect | `REMOTE_ACCEPTED` / `REMOTE_EFFECT_CONFIRMED` (contract-defined) | Only the provider/receiver result explicitly and authentically attested | Any broader effect, retention, or deletion not covered by the evidence contract |

Evidence for one stage is never promoted automatically to the next stage. Even a recorded local network start is not proof of remote arrival. A receipt proves only the semantics its authenticated contract specifies.

### 3.2 State interpretation and linearization

- `SEND_AUTHORIZED` / `DELIVERY_AUTHORIZED`: Coordinator committed a current operation grant bound to the exact protected payload, destination, policy, and fence.
- `SEND_STARTED` / `DELIVERY_STARTED`: local operation start only. These states do not mean the Adapter method was entered.
- `DISPATCH_CLAIMED`: a single-use claim won the per-scope Coordinator/Gate serialization order against the delete barrier. It is not itself proof of Adapter entry.
- `ADAPTER_INVOCATION_OBSERVED`: local method entry was durably observed after the call boundary. If the Gate crashes between claim and this observation, `DISPATCH_BOUNDARY_UNKNOWN` applies.
- `NETWORK_REQUEST_INITIATION_OBSERVED`: optional future local transport evidence. It does not prove bytes left the host; exact instrumentation is **Unresolved**.
- `REMOTE_RECEIPT_CONFIRMED`, `REMOTE_ACCEPTED`, `REMOTE_EFFECT_CONFIRMED`: only recorded from authenticated evidence sufficient for each named claim. Unsupported stages remain unproven.
- `SEND_OUTCOME_UNKNOWN` / delivery equivalent: external outcome may exist but current evidence cannot determine it. No automatic retry or success claim.

The dispatch claim and deletion barrier continue to compete under the same per-scope Coordinator sequencer as v3.6 Section 7. A barrier that commits first invalidates old grants and prevents later claims. A claim that wins first orders the local Adapter entry before the barrier in a healthy, exclusively fenced Gate. This is not atomicity with the network or provider.

### 3.3 Failure and evidence matrix

| Failure point | Evidence available | Correct classification | Prohibited inference/action |
|---|---|---|---|
| Delete barrier commits before dispatch claim | Journal order shows no claim before barrier | Cancel before Adapter only if Gate/journal positively establishes no prior claim/entry; otherwise retain boundary uncertainty | Do not infer no call solely from a missing log record |
| Crash after claim, before Adapter-entry evidence | Claim exists; entry may or may not have occurred | `DISPATCH_BOUNDARY_UNKNOWN` | Do not replay, declare cancelled, or declare sent |
| Adapter entry observed, network initiation absent | Local call entry only | Network state unresolved | Do not claim no network attempt or remote receipt |
| Network initiation observed, reply missing | Local transport activity only | Remote arrival/outcome unknown | Do not claim bytes left/arrived or automatically retry |
| Authenticated receipt says received, acceptance absent | Receipt-defined receipt only | Receipt confirmed; acceptance unresolved | Do not claim accepted/executed |
| Authenticated acceptance without effect evidence | Provider acceptance only | `REMOTE_ACCEPTED`; effect unresolved | Do not claim effect or completion beyond contract |
| Effect receipt missing after an operation may have run | Potential external effect | `SEND_OUTCOME_UNKNOWN` | No automatic retry or success claim |
| Positive authenticated evidence proves a stage did not occur | Stage-specific negative evidence | Record only that stage's negative result | Do not generalize to later/earlier stages without proof |

Absence of evidence is not evidence of non-entry, non-transmission, or non-receipt. The v3.6 no-replay rule for unknown outcomes is **Preserved**. The additional stage vocabulary is **Proposed**. Adapter/network instrumentation, receipt contracts, and proof of negative outcomes are **Unresolved** and BLOCKERS before stronger claims.

Result Delivery follows the same staged-evidence rule: local Delivery Adapter entry, local network initiation, receiver arrival, and handoff/receipt are separate. `HANDOFF_CONFIRMED` remains limited to authenticated evidence and does not imply a human read.

## 4. Local Deletion Verification and Completion

This section clarifies v3.6 Sections 12-14. `LOCAL_DELETION_COMPLETED` describes a bounded local operational result only. It does not assert universal physical erasure, non-restorability, provider-side deletion, or absence of unknown external effects.

### 4.1 Required storage inventory

Before local completion is considered, create and review a versioned inventory manifest for the affected deletion scope. It must identify each known artifact class, its source/owner, cleanup or invalidation action, resulting evidence, and any unresolved copy/restore path. At minimum examine:

| Artifact class | Required review evidence |
|---|---|
| Memory Content Store | Exact affected objects enumerated; removal or cryptographic-inaccessibility result recorded |
| Projections and Indexes | Current projections, search/relationship indexes, embeddings, summaries and rebuild sources filtered/rebuilt; stale generations invalidated |
| Temporary Context and Caches | Task/session contexts, process caches, temporary files, swap/spool locations within the approved inventory addressed; inaccessible or unknown locations remain unresolved |
| Protected Link Store | Affected mapping removed/cryptographically inaccessible; no inferred replacement; missing/corrupt mapping blocks scope verification |
| Payload Binding Vault | Per-operation payload commitments, operation keys, grant mappings and staged references removed or cryptographically inaccessible; no digest copied into public audit |
| Key Store and key backups | Affected Key Generations revoked/destroyed; all known wraps, replicas, escrow/recovery copies and restore routes inventoried and evidenced |
| Local Backups and recovery sources | Snapshot inventory and restore-source coverage reviewed; current tombstone/key floor is enforced before visibility; stale images cannot lower floors |
| Consolidation proposals and temporary outputs | Source ranges, checkpoints, digests, proposals, drafts and temporary context for the scope removed or cryptographically inaccessible |
| Protected Egress Staging and receipts | Exact staged payloads and content-bearing receipts handled under their retention/deletion rules; status-only evidence minimized |
| Other copies or derivatives | Any additional item discovered by storage/backup inventory is added to the manifest and dispositioned before completion |

An incomplete inventory, inaccessible store, unknown key copy, unresolved mapping, or unverified restoration route prevents a complete inventory attestation. Do not convert a missing inventory result into a claim that no copy exists.

### 4.2 Separate evidence states

Track these as separate results:

- `LOCAL_CLEANUP_EXECUTED`: each item in the approved inventory has a recorded cleanup/invalidation action and corresponding per-store evidence. This proves execution of listed actions only.
- `LOCAL_RESTORE_GUARD_VERIFIED`: all known local restore paths are required to apply the latest tombstone and key-generation floor before data/key visibility. This proves a guard rule, not physical removal of every backup byte.
- `LOCAL_NON_RESTORABILITY_VERIFIED`: only when evidence establishes that all usable key copies/wrappings and recovery paths capable of restoring the affected content are unavailable under the approved threat model. The absence of a known copy is insufficient proof.
- `LOCAL_DELETION_COMPLETED`: may be recorded only after the gate remains closed for the scope, tombstone/barrier is current, inventory is complete, each inventoried item has a verified disposition, cleanup evidence is committed, and the restore guard is verified. Its label means local access/cleanup obligations in the defined inventory are complete; it does not imply `LOCAL_NON_RESTORABILITY_VERIFIED` unless that separate state is also recorded.

If a listed artifact is unknown or unresolved, do not claim `LOCAL_CLEANUP_EXECUTED` or `LOCAL_DELETION_COMPLETED` for the whole scope. If physical media or backup bits cannot be proven erased, say so; do not imply physical erasure. `LOCAL_NON_RESTORABILITY_VERIFIED` is not inferred from cleanup completion or key-destruction intent.

### 4.3 External effects remain separate

Keep `EXTERNAL_EFFECT_NONE_PROVEN`, `EXTERNAL_EFFECT_CONFIRMED`, `EXTERNAL_EFFECT_REJECTED`, and `EXTERNAL_EFFECT_UNKNOWN` separate from all local deletion statuses. Provider-side deletion has its own request/receipt states. No remote deletion claim is valid without authenticated provider evidence whose contract establishes deletion, not merely request acceptance. A permanently unknown remote outcome may coexist with a proven `LOCAL_DELETION_COMPLETED`, but must remain visible as an unresolved external risk.

Classification: local/remote deletion separation and no unsupported erasure claim **Preserved**; inventory gate and independent cleanup/restoration proof states **Proposed**; completeness of real-world artifact enumeration, backup coverage, key recovery copies, and physical erasure evidence **Unresolved**.

## 5. Coordinator Admission Projection

This section clarifies v3.6 Sections 3, 5, 7, and 14 without creating another authority.

### 5.1 Source of truth

The Coordinator Journal is the sole source of truth for committed admission decisions, barriers, grants, revocations, Fencing Generations, and commit order. Coordinator Admission State is a materialized projection of those committed events. It has no independent authority to create order, grant permission, override a tombstone, or lower a fence.

### 5.2 When the projection may be used

- An admission/dispatch/delivery decision may use Admission State only within a Coordinator-controlled transaction/snapshot that verifies the projection watermark and state version correspond to the current authoritative Journal revision/commit head and Fencing Generation, and that no later committed barrier is omitted.
- The decision must still be committed by the Coordinator against the expected Journal revision and fence. Reading a projection alone never authorizes an operation.
- A query/UI may use a lagging projection only when explicitly marked stale and when the result cannot authorize access, dispatch, delivery, or visibility. Otherwise it must wait for catch-up or read an authoritative consistent state.
- No separate subsystem, Adapter, or worker may treat a cached projection as current authority.

The exact transaction/isolation mechanism is a storage design choice and remains unselected. The semantic requirement is a consistent read of journal-derived state at the decision linearization point.

### 5.3 Staleness, loss, and conflict

Every projection carries a source Journal Revision, highest applied `commit_sequence`, and integrity/checkpoint reference. Before a decision, the Coordinator must compare these to its authoritative current state. If behind, missing, ahead without a committed source, non-monotonic, duplicated inconsistently, or hash/checkpoint-conflicting:

1. Do not use the projection for authorization or gate opening.
2. Rebuild/replay from the Coordinator Journal or read the authoritative state transactionally.
3. Keep affected admission, egress, delivery, and visibility fail-closed until consistency is restored.
4. On contradictory sequence/event evidence or unavailable authoritative Journal, enter `RECOVERY_REQUIRED`; do not repair by guessing.

A missing projection may be rebuilt from the journal because it is derived state. A missing or corrupt journal cannot be reconstructed from the projection. No projection write may issue a new `commit_sequence` or change the ordering history.

Classification: single journal authority and derived Admission State **Preserved** from v3.6; explicit watermark validation/use rules **Modified/clarified**; precise storage transaction implementation **Proposed**; implementation/isolation proof **Unresolved**.

## 6. Historical Traceability and Source Integrity

### 6.1 Evidence status

The available project documents at review time are v3.4, v3.5, and v3.6. v3.6 itself states that original v1.0-v3.3 source documents were unavailable. Historical decisions supplied in user requests are recorded as user-supplied evidence, not as independently verified original release text. Exact first-release attribution remains unavailable unless a source document proves it.

### 6.2 Correction traceability matrix

| Original decision / issue | Historical evidence source | First known version | v3.6.1 location | Classification | Reason / approval | Validation status |
|---|---|---|---|---|---|---|
| Resumable sleep-time consolidation with source range/hash and output digest | v3.6 Section 19 | v3.6 | Section 1 | Modified | Preserve resumability but classify all content-derived/linkable job metadata as sensitive; protected store and retention require approval | Documentary only; store/access/retention not implemented |
| Do not leak personal content fingerprints to public journal/Witness/audit | v3.6 §§5.2, 6.3-6.5; current request | v3.6 plus current correction | Sections 1 and 6 | Preserved/clarified | Plain hashes and MACs are not assumed anonymous; exact construction remains unresolved | No privacy testing performed |
| Retrieval is task-scoped, bounded, and respects authorization and deletion | v3.6 §§2, 4, 18; current request | v3.6 | Section 2 | Modified | Sensitivity alone no longer excludes authorized local use; time applicability and missing-required-time are distinct | No retrieval evaluation performed |
| Adapter entry is distinct from external success; `DISPATCH_BOUNDARY_UNKNOWN` on uncertain crash | v3.6 §§7-9, 22; current request | v3.6 | Section 3 | Preserved/expanded | Add local network initiation and remote receipt/effect evidence without promoting one stage to another | No adapter/network evidence tested |
| Verify local deletion across all storage/backup derivatives | v3.6 §§12-14; current request | v3.6 | Section 4 | Modified | Require reviewed artifact inventory and separate cleanup from non-restorability proof | No deletion executed or tested |
| Admission State is a projection; Journal is sole order authority | v3.6 §§2-5, 7, 14 | v3.6 | Section 5 | Preserved/clarified | Define watermark/current-state checks, stale handling, rebuild, and recovery | No transaction implementation validated |
| Historical first versions v1.0-v3.3 | v3.6 historical limitation; project docs available | Unavailable | Sections 6.1-6.2 | Unresolved | No original artifacts; no release attribution invented | Source gap remains |

### 6.3 Source corruption observed; no repair inferred

The current v3.6 source contains visible text damage:

1. The opening title line reads `# Delivery Gate | The only component permitted to invoke a Resu Jarvis Memory Architecture v3.6`. It is not a valid, complete architecture title. Its intended wording cannot be determined from that line alone.
2. In Section 3's component table, one row begins `|lt Delivery Adapter. Applies the same ordering and fencing rules as Egress Gate.` It is malformed as a table row and appears to have lost component/column text. The missing text and intended columns cannot be reliably reconstructed from this row.

This correction does not repair or normalize v3.6. It relies only on intact, separately stated provisions where needed and records this source-integrity limitation. If the malformed row affects a claim not independently stated elsewhere, that claim is **Unresolved** and must not be treated as approved based on a guessed reconstruction.

## 7. Remaining Blockers and Readiness

- **BLOCKER-361-01 Consolidation metadata:** approve protected-store boundary, access roles, checkpoint cryptographic construction/key lifecycle, job terminal states, retention, and backup handling before durable consolidation metadata is written.
- **BLOCKER-361-02 Retrieval policy:** approve sensitive-data categories, local authorization policy, external egress policy, task temporal-requirement classification, and behavior for invalid/unknown times.
- **BLOCKER-361-03 Adapter evidence:** define trusted instrumentation for local method entry and network initiation, provider/receiver receipt semantics, negative evidence, and stage-specific reconciliation. No claim may exceed the evidence.
- **BLOCKER-361-04 Deletion inventory:** establish a complete, reviewable inventory of local stores, replicas, key copies, backups, restore sources, caches, and consolidation artifacts. Unknown items block whole-scope completion.
- **BLOCKER-361-05 Restoration proof:** define what evidence is sufficient for `LOCAL_RESTORE_GUARD_VERIFIED` and `LOCAL_NON_RESTORABILITY_VERIFIED`; do not equate cleanup with irrecoverability.
- **BLOCKER-361-06 Admission projection:** prove the Coordinator's consistent-read/current-watermark rule and fail-closed behavior against the selected storage design.
- **BLOCKER-361-07 Source corruption:** recover an authoritative clean v3.6 source from an approved source if decisions depend on the damaged title/table row. Do not edit the current v3.6 in this task.
- **BLOCKER-361-08 Historical record:** original v1.0-v3.3 documents remain unavailable; exact first versions cannot be verified.

The status remains **Architectural Consistency Correction — Not Approved for Implementation**. Phase A and Phase B remain unauthorized. This document does not authorize tests, simulations, code/database changes, real deletion/encryption, or external service calls.

## 8. Correction Summary

| Issue | Correction | Status |
|---|---|---|
| Consolidation privacy | Treat range/hash/output digest as sensitive/linkable; protect outside public records; access and retention values remain explicitly unresolved | Partial design proposal; blocker remains |
| Retrieval filtering | Sensitivity no longer causes blanket local exclusion; distinguish invalid, non-temporal, and required-but-unknown time | Corrected as policy rules; classifier/policy approval remains |
| Adapter/external stages | Separate local entry, network initiation, remote receipt, and accepted/effected outcome; never infer next stage | Corrected as evidence model; instrumentation/contracts unresolved |
| Local deletion proof | Require complete artifact inventory; separate cleanup execution, restore guard, and non-restorability evidence | Corrected as status model; inventory and proof unresolved |
| Admission Projection | Journal remains sole authority; projection usable only with current watermark and Coordinator transaction validation | Corrected as consistency rule; implementation proof unresolved |

No operational validation was performed. Any future claim must be supported by approved evidence and may not be inferred from this document.
