# Jarvis Memory Architecture v3.6.2

Status: Architectural Consistency Correction — Not Approved for Implementation

Date: 2026-11-03
Corrects: `docs/jarvis-memory-architecture-v3.6.1.md`
Reviewed sources: `docs/jarvis-memory-architecture-v3.6.md`, `docs/jarvis-memory-architecture-v3.6.1.md`, `docs/jarvis-memory-architecture-v3.5.md`, and `docs/jarvis-memory-architecture-v3.4.md`

## 1. Applicability, Authority and Classification

This document is a narrowly scoped final documentation correction for the five topics below. It is not a full republication of v3.6.1. Provisions in v3.6.1 and v3.6 remain incorporated by reference except where a correction below explicitly governs the same topic. The v3.5 and v3.4 decisions explicitly preserved in v3.6 remain preserved. A damaged source passage is not reconstructed by inference.

This document does not approve implementation, testing, simulation, deletion, encryption, migration, external service use, Phase A, or Phase B. It proves no runtime, privacy, cryptographic, erasure, or recovery guarantee.

### 1.1 Decision classifications

These classifications are used consistently in this document and its correction register:

- **PRESERVED:** a documented or supplied requirement is carried forward without changing its meaning. This label does not prove implementation.
- **MODIFIED:** an existing requirement's scope or semantics is intentionally changed or narrowed. The prior rule, new rule, and reason must be stated.
- **CORRECTED:** an internal contradiction or ambiguity is resolved by explicitly distinguishing meanings or states, without weakening a separate existing guarantee. The precise inconsistency and corrected interpretation must be traceable.
- **PROPOSED:** a new mechanism or procedure is suggested, but is not an approved historical decision or selected implementation.
- **UNRESOLVED:** available sources do not establish an answer or evidence sufficient to make the claim. It remains a blocker; no assumption fills the gap.

`CORRECTED` is not a synonym for improved, tested, secured, or implemented. A correction can coexist with a `PROPOSED` mechanism and an `UNRESOLVED` implementation proof.

### 1.2 Source authority

The Coordinator Journal remains the only source of committed event order. Local states, projections, logs, network observations, and receipts have only the explicitly defined evidentiary meanings below. The v3.6 document's damaged title and component row remain damaged; this document records the damage and does not infer their intended text.

## 2. A — Consolidation Metadata Privacy

### 2.1 Problem and previous rule

v3.6 Section 20.1 proposes persisting a `source event range/hash`, source commit range, checkpoint, and deterministic output digest to resume Sleep-time Consolidation. v3.6.1 Section 1 correctly identifies ranges, hashes, deterministic digests, and opaque job identifiers as potentially personal or linkable, proposes a protected store, and leaves actual retention/access policy unresolved.

A hash is not encryption or anonymization. A digest or MAC can reveal equality, permit guessing, or link jobs when inputs/keys are stable. A commit range can reveal a user's activity through sequence or timing correlation. Neither a random job ID nor encryption alone proves unlinkability from timing, size, access, or associated records.

### 2.2 Corrected classification and storage rule

Treat the following as **sensitive, potentially linkable operational metadata** unless a reviewed analysis establishes otherwise:

- journal/event and commit ranges;
- source/checkpoint hashes or commitments;
- deterministic output digests;
- job/proposal identifiers and mappings to sources, outputs, reviewers, or subjects;
- checkpoint status and timestamps when correlated with activity.

**PRESERVED:** Consolidation is resumable and proposal/review based; it does not automatically write confirmed memories. **CORRECTED:** resumability does not authorize public or cross-domain disclosure of source ranges or content-derived digests. **PROPOSED:** retain such values only in a logically separate, access-controlled Consolidation Job Metadata Store, using a separately approved key domain. No physical store or cryptographic construction is selected here.

The metadata and any link to personal content must not be written in plaintext or as directly comparable fingerprints in the Coordinator Journal, Memory Event Log, Witness manifest, general audit/diagnostic/telemetry logs, ordinary projection, or public backup manifest. If an integrity reference is required in a control event, it must be a protected, non-content-revealing reference whose linkage properties have been reviewed; otherwise the reference is **UNRESOLVED** and must not be emitted.

### 2.3 Access and retention

**PROPOSED least privilege:** the Consolidation Worker can access metadata only for its active job; the Coordinator can validate job state using a restricted interface; a reviewer sees proposal and necessary provenance but not source hashes/ranges unless separately authorized; recovery/security access is purpose-limited and audited; Witness and general log consumers have no direct access.

These roles are design proposals, not evidence that an implementation enforces them. Retention for active, completed, rejected, paused, and recovery jobs is **UNRESOLVED**. No numeric duration is invented. Until an owner approves terminal states, retention, access, deletion, exception, and backup rules, durable persistence of these content-derived values is blocked.

At job termination, the content-derived values and person/source mapping must be removed or cryptographically invalidated under an approved policy; what non-content job outcome may remain and for how long is **UNRESOLVED**. The design must not claim unlinkability solely from the proposed store boundary.

### 2.4 Failure and deletion interaction

- If a checkpoint is missing, corrupt, stale against the Journal, or inconsistent with a deletion barrier, do not resume from it. Recompute only from still-authorized surviving events after verifying source revisions; otherwise stop the job for review.
- If deletion is requested, stop consolidation from reading or producing artifacts for that scope. Inventory and disposition must include ranges, checkpoints, digests, proposals, drafts, intermediate output, and job-to-source mappings.
- If the exact source mapping or deletion disposition cannot be established, mark the job/artifact `UNRESOLVED`; do not infer that it contains no personal data.
- Hash/checkpoint integrity is distinct from privacy. A valid digest proves neither absence of personal data nor deletion.

**Correction register:** prior resumable/review-only consolidation **PRESERVED**; public disclosure risk and hash/non-anonymity semantics **CORRECTED**; isolated metadata store and least-privilege access **PROPOSED**; cryptographic construction, actual access enforcement, retention, and unlinkability **UNRESOLVED**.

## 3. B — Send/Adapter Failure Before `DISPATCH_CLAIMED`

### 3.1 Problem and preserved rule

v3.6 Sections 7-8 distinguish `SEND_STARTED` from `DISPATCH_CLAIMED`, and state that `SEND_STARTED` alone proves no Adapter invocation. v3.6 Section 22.2 also says that after `*_STARTED` with no receipt, the outcome is `*_OUTCOME_UNKNOWN`. That latter rule is overbroad for an operation that is known to have stopped before any dispatch claim: absence of a receipt is not enough to classify such a local-only operation as externally unknown.

**PRESERVED:** no automatic retry where external action may have occurred but cannot be determined; no success or rejection is inferred without evidence. **CORRECTED:** distinguish an operation stopped before any dispatch claim from an operation whose Adapter boundary may have been crossed.

### 3.2 Separate evidence stages

| Stage | State/evidence | What it establishes | What it does not establish |
|---|---|---|---|
| Authorization | `SEND_AUTHORIZED` | Coordinator committed a grant for the protected payload/destination/policy | Worker start or Adapter call |
| Local worker start | `SEND_STARTED` | Local work was accepted/started | Dispatch claim, Adapter entry, network start, or external receipt |
| Local stop before claim | `SEND_STARTED` with worker stopped and no dispatch claim committed; proposed disposition `SEND_STOPPED_PRE_CLAIM` | Only if the Coordinator Journal is authoritative and the relevant Gate/worker has been fenced: no committed claim exists and the old worker cannot later claim | Without proof of complete Gate fencing, it does not prove the worker cannot resume or that no other Gate acted |
| Explicit cancellation before Adapter | `SEND_CANCELLED_BEFORE_ADAPTER` | A serialized Gate/recovery record proves the Adapter method was not entered and the old worker/Gate cannot enter it later | Network or external result; it says that this operation did not reach Adapter only under the verified Gate contract |
| Claim | `DISPATCH_CLAIMED` | The single-use claim won the Coordinator/Gate serialization order against the delete barrier | Adapter method entry, network transmission, or external arrival |
| Adapter entry | `ADAPTER_INVOCATION_OBSERVED` | The local Gate durably recorded entry into Adapter after that boundary | Network request initiation, bytes leaving the device, or provider arrival |
| Network initiation | `NETWORK_REQUEST_INITIATION_OBSERVED` if an approved instrument exists | Only the exact local transport event specified by that instrument | Packet transmission or remote arrival unless independently evidenced |
| External receipt/result | Authenticated receipt with defined semantics | Only receipt/acceptance/effect explicitly attested by that contract | Any later stage or broader effect not in the contract |

States describing `SEND_STOPPED_PRE_CLAIM` and `NETWORK_REQUEST_INITIATION_OBSERVED` are **PROPOSED** vocabulary, not historic or implemented state. They must not be adopted until transition ownership and durable event semantics are approved. Existing `SEND_CANCELLED_BEFORE_ADAPTER`, `DISPATCH_BOUNDARY_UNKNOWN`, and `SEND_OUTCOME_UNKNOWN` retain their v3.6 meanings.

### 3.3 Worker stop before claim

If a worker stops after `SEND_STARTED` but before `DISPATCH_CLAIMED`:

1. Do not label it sent, rejected, or externally `SEND_OUTCOME_UNKNOWN` merely because no receipt exists.
2. The Coordinator may disposition it as stopped/cancelled before dispatch only if the authoritative Journal shows no committed claim for the operation and the relevant Gate/worker epoch is verifiably fenced so no in-flight or stale worker can later claim or invoke Adapter.
3. If this evidence is incomplete, inconsistent, unavailable, or the Gate could have proceeded outside the journaled claim path, use `DISPATCH_BOUNDARY_UNKNOWN` / `RECOVERY_REQUIRED` as appropriate. Do not infer non-invocation from a missing log record.
4. No automatic requeue/retry follows either a proven cancellation or an uncertain stop. A new attempt requires a new Coordinator authorization after current barrier/fence/payload checks; where the prior outcome may have crossed a boundary, duplicate-risk approval and external evidence policy remain blockers.

This rule does not assume that `SEND_STARTED` and claim are in the same transaction, nor that the Coordinator can cancel an external operation.

### 3.4 Failure transition matrix

| Interruption | Required evidence | Disposition | Retry/claim rule |
|---|---|---|---|
| Worker exits after `SEND_STARTED`, before claim | Journal has no committed claim; Gate/worker fenced; no uncommitted claim can complete | Proposed `SEND_STOPPED_PRE_CLAIM` or existing explicit cancellation disposition | No automatic retry; any new attempt requires new authorization |
| Delete barrier commits before claim | Barrier and higher Fencing Generation committed before claim | Cancel old grant; `SEND_CANCELLED_BEFORE_ADAPTER` only if no-entry proof and fencing are complete | Old grant cannot be reused |
| Claim is committed; crash before Adapter-entry evidence | Claim exists, entry cannot be proven or excluded | `DISPATCH_BOUNDARY_UNKNOWN`; fence old Gate | Never replay automatically |
| Adapter entry observed; network initiation unknown | Local method entry only | External dispatch/network status unresolved | No non-send or send claim |
| Network initiation observed; remote receipt absent | Approved local initiation evidence only | External arrival/outcome unknown | No automatic retry |
| Authenticated remote receipt exists | Receipt contract and binding validated | Record only the receipt-supported state | Do not infer execution/deletion beyond receipt |

**Result Delivery:** apply the same distinctions and gates to `DELIVERY_STARTED`, `DELIVERY_DISPATCH_CLAIMED`, Delivery Adapter entry, network initiation, receiver arrival, and handoff. A local delivery start is not a handoff. Unknown delivery outcome is not automatically retried.

**Correction register:** no success from `STARTED`, one Coordinator order source, fencing, and no retry on unknown external effect **PRESERVED**; distinguish local pre-claim stop from external uncertainty **CORRECTED**; explicit `SEND_STOPPED_PRE_CLAIM` label and transport-start event **PROPOSED**; proof of Gate fencing, transaction ordering, and network/receipt instrumentation **UNRESOLVED**.

## 4. C — Deletion Inventory and Restore-Guard Evidence

### 4.1 Meaning of a complete inventory

A complete inventory is complete only relative to an explicitly approved deletion scope, data-location model, and enumerated discovery sources. It is not a claim that undiscovered media or every physical bit everywhere has been found.

For the target scope, the reviewed inventory must identify, at minimum:

- Memory Content Store objects and replicas;
- current and historical Projections, indexes, embeddings, graph edges, derived summaries, and rebuild sources;
- Temporary Context, task/session caches, process caches, temporary/spool files, and other in-scope transient storage;
- Protected Link Store mappings and replicas;
- Payload Binding Vault records, binding keys, references, and copies;
- Key Store generations, wraps, replicas, escrow/recovery copies, and key backups;
- Local Backups, snapshots, replicas, and every declared local restore/recovery source;
- Sleep-time Consolidation proposals, source ranges, checkpoints, digests, drafts, intermediate outputs, and temporary context;
- Protected Egress Staging payloads and locally retained content-bearing receipts;
- any additional copies/derivatives found by the approved store, replication, backup, cache, or projection inventory.

The discovery-source list, scope boundary, completeness method, and accountable reviewer must be recorded before whole-scope completion can be considered. This method is **PROPOSED**; specific storage discovery technology is unselected.

### 4.2 Inventory record and unknown locations

For each artifact class/item, record only the minimum necessary evidence: deletion-operation reference, opaque store/item reference where essential, artifact class, discovery source, disposition (`REMOVED`, `CRYPTOGRAPHICALLY_INACCESSIBLE`, `RETAINED_UNDER_RESTORE_GUARD`, or `UNRESOLVED`), action/evidence reference, verification status, and applicable key/restore revision. Do not put content, direct personal identifiers, public hashes/MACs of personal content, detailed personal paths, or stable cross-context subject IDs into a general audit record.

The inventory itself may reveal a user's data layout and is **sensitive/linkable operational metadata**. Its content and any mapping to a person/scope must be protected by least privilege; exact store, key, role, and retention are **UNRESOLVED** and require approval. Public Journal/Witness/audit surfaces may carry only a minimized non-content verification result and protected opaque reference if approved. A public checksum of the inventory does not make it anonymous.

Every location is explicitly marked `INSPECTED`, `NOT_APPLICABLE_WITH_BASIS`, `UNINSPECTED`, or `UNRESOLVED`; a missing result is not interpreted as absence. If a declared backup, key copy, cache, replica, or recovery source cannot be inspected or its disposition verified, the whole-scope inventory is incomplete and `LOCAL_DELETION_COMPLETED` must not be recorded.

### 4.3 Restore-guard proof

Before `LOCAL_RESTORE_GUARD_VERIFIED`, require evidence that:

1. the latest applicable tombstone and Deletion Revision are obtained from the authoritative Coordinator/Witness sources defined by the approved deployment;
2. the restore procedure blocks visibility, key unwrap, retrieval, dispatch, and delivery until that revision and the applicable Key Generation floor are reconciled;
3. each declared Local Backup and recovery source has a documented path by which the current tombstone/floor is applied before data can be served;
4. restored projections, caches, links, staging, and consolidation artifacts cannot bypass the gate or be used before filtering;
5. the active restore/gate/Coordinator authority is current and stale epochs/fences cannot reopen the scope;
6. recovery logs and tests/evidence (when later authorized) identify the exact policy/version and sources covered.

A policy statement or manifest alone is not proof that each restore implementation enforces the guard. If a required source is unknown, uninspected, unavailable, or lacks proof, record `UNRESOLVED` and keep the affected visibility/key gates closed.

### 4.4 Separate cleanup from recoverability

- `LOCAL_CLEANUP_EXECUTED` proves that listed cleanup actions were performed and recorded for the inventoried scope. It does not prove inventory completeness or irrecoverability.
- `LOCAL_RESTORE_GUARD_VERIFIED` proves the defined restore path applies current deletion/key floors before exposure. It does not prove physical backup bytes were erased.
- `LOCAL_NON_RESTORABILITY_VERIFIED` may be asserted only if an approved technical basis demonstrates that all usable key copies/wrappings and recovery paths capable of restoring the scoped content are unavailable under a stated threat model. v3.6.1 supplies no such complete proof.
- `LOCAL_DELETION_COMPLETED` is forbidden if any required location is uninspected/unresolved, any inventory evidence is missing, cleanup for an in-scope artifact is unverified, or the restore guard is unverified. It means only completion of the approved and evidenced local scope; it never implies provider-side deletion, universal physical erasure, or absolute impossibility of recovery.

Unknown paths keep `LOCAL_DELETION_COMPLETED` blocked. Do not replace missing evidence with an assumption. Do not claim physical erasure without physical-erasure evidence.

**Correction register:** v3.6.1's required artifact classes and separation of local/external deletion **PRESERVED**; inventory completeness and evidence gates **CORRECTED/clarified**; inventory format and guard-verification method **PROPOSED**; completeness across actual unknown stores, key copies, backups, and physical media **UNRESOLVED**.

## 5. D — Privacy of Deletion Inventory Records

### 5.1 Classification and minimization

Deletion inventory records, artifact references, store locations, key-copy lists, backup paths, cleanup evidence, and tombstone/link references are sensitive and potentially personal/linkable even if they contain no payload. Their classification does not become “public” because the identifiers are opaque or because values are hashed.

Keep only the fields needed to prove an approved local deletion disposition. Prefer per-deletion random references, artifact-class identifiers, status, and protected evidence references over names, plaintext content, detailed filesystem paths, raw payload digests, or stable user/object IDs. This is a minimization requirement, not proof of unlinkability.

### 5.2 Access, audit and copies

**PROPOSED least privilege:** authorized deletion/recovery personnel and the Coordinator's deletion verifier may access the detailed inventory only for the affected operation and purpose. General log readers, Witness, unrelated workers, and normal retrieval/analytics do not receive item-level inventory. Access to the detailed record is itself minimized and auditable, but the access audit must not duplicate personal location/content details.

The detailed inventory is stored within an approved protected boundary; no physical store, cryptographic mechanism, or key technology is selected. Public Coordinator Journal/Witness entries may contain only a minimized completion state and protected reference after approval. Local backups containing the inventory must be included in the inventory itself and governed by the restore guard.

### 5.3 Retention

No numeric inventory retention period is established by v3.4-v3.6.1. Retention of the detailed inventory, evidence references, access history, and backup copies is **UNRESOLVED** and requires an owner decision based on audit need and privacy risk. Until approved, no permanent detailed inventory or direct personal mapping may be assumed acceptable. Deleting the inventory must not silently erase the minimal non-personal ordering evidence required by the append-only Journal; conversely, append-only ordering does not authorize retaining personal inventory contents indefinitely.

**Correction register:** v3.6.1's instruction to minimize metadata and avoid public content fingerprints **PRESERVED**; explicit sensitive classification and access/retention separation **CORRECTED/clarified**; least-privilege store policy **PROPOSED**; actual roles, retention, backup treatment, and unlinkability **UNRESOLVED**.

## 6. E — Admission Projection Consistency

### 6.1 Source and relationships

- **Coordinator Journal:** sole source of truth for committed admission decisions, grants, revocations, deletion barriers, Fencing Generation changes, and their `commit_sequence` order. Only a committed Journal event can establish one of these decisions.
- **Commit Sequence:** order assigned by the Coordinator to committed Journal events; it is not a projection watermark and is not assigned by any projection.
- **Admission Projection:** materialized, derived view of the latest applicable Journal events for fast admission checks. It has no independent authority, cannot mint order or permission, and cannot lower a fence or override a tombstone.
- **Watermark:** proposed projection metadata indicating the highest Journal event/order actually applied, together with the Journal Revision/checkpoint needed to identify the applied source. It must not be interpreted as a separately allocated sequence or authority. Exact representation is **UNRESOLVED**.
- **Fencing Generation:** value established by committed Coordinator events. The projection may cache it, but a cached value is not authoritative when stale or inconsistent.

### 6.2 Use for decisions

Admission Projection may be consulted for a grant/dispatch/delivery decision only when the Coordinator can establish a consistent Journal snapshot/current head and prove the projection is not behind that state and omits no later committed barrier or generation change. The final decision must be committed against the expected Journal revision/commit head and Fencing Generation. Reading a projection alone never authorizes an operation.

The source does not establish a specific database isolation or transaction mechanism that guarantees this check-and-commit property. No such mechanism is invented here. Until the implementation has a reviewed consistency proof, decisions must read the authoritative Journal state through a mechanism that can establish the required consistency or fail closed.

### 6.3 Failure and recovery behavior

| Condition | Required behavior | Prohibited behavior |
|---|---|---|
| Projection behind Journal/watermark stale | Do not use it to authorize, dispatch, deliver, or open visibility. Catch up/rebuild or read authoritative state consistently. | Do not assume no newer delete barrier exists |
| Projection missing | Rebuild from the authoritative Journal; gate decisions that require the projection until rebuilt or use a consistent Journal read | Do not treat missing projection as empty/open state |
| Projection corrupt or hash/checkpoint invalid | Mark unusable; rebuild from Journal; if integrity cannot be established, enter `RECOVERY_REQUIRED` and fail closed | Do not repair by guessing or use corrupted permissions/fence |
| Projection ahead of Journal, duplicate/inconsistent events, or sequence mismatch | Stop decisions and reconcile from authoritative Journal; unresolved mismatch means `RECOVERY_REQUIRED` | Do not advance Journal from the projection or create a competing order |
| Crash after Journal commit but before projection update | Journal commit remains authoritative; projection is stale and unusable for decisions until verified catch-up/rebuild | Do not roll back the committed event or assume projection update also committed |
| Crash during a shared-storage transaction | Consult the storage engine's documented transaction result and authoritative Journal; if outcome cannot be proven, `RECOVERY_REQUIRED` | Do not claim atomicity without selected-store evidence |
| Journal missing/corrupt | Projection cannot reconstruct the canonical history; keep admission/visibility/egress blocked and invoke approved recovery | Do not elevate the projection to source of truth |

**Correction register:** one Journal source, Admission State as derived projection, and rebuild-on-failure **PRESERVED** from v3.6; watermark and failure semantics **CORRECTED/clarified**; watermark representation and consistent check/commit mechanism **PROPOSED**; storage/isolation proof **UNRESOLVED**.

## 7. Classification and Historical Traceability

### 7.1 Status mapping before and after v3.6.2

| Topic | v3.6/v3.6.1 status | v3.6.2 status | Why |
|---|---|---|---|
| Sleep-time Consolidation remains resumable and proposal/review based | PRESERVED | PRESERVED | No change to the prior behavior; its metadata privacy is separately constrained |
| Public exposure of personal-content digest prohibited | v3.6.1 rule | PRESERVED | Retained; hashes are not treated as anonymization |
| Detailed metadata store/access/retention | PROPOSED / UNRESOLVED | PROPOSED / UNRESOLVED | No store, role implementation, or retention authority is selected |
| Sensitive local retrieval distinct from cloud egress | CORRECTED in v3.6.1 | PRESERVED | v3.6.2 does not reverse that correction |
| `SEND_STARTED` is a local start, not Adapter entry | CORRECTED in v3.6.1 against v3.5's conflicting wording | PRESERVED | v3.6.2 adds pre-claim worker failure semantics without redefining the state |
| `SEND_STARTED` with no receipt always means external outcome unknown | v3.6 Section 22.2 broadly says unknown after `*_STARTED`; v3.6.1 locally narrows semantics but does not replace that table | CORRECTED | Outcome depends on whether a claim/Adapter boundary may have been crossed and whether the Gate is fenced |
| `DISPATCH_BOUNDARY_UNKNOWN` and no automatic retry after uncertain dispatch | PRESERVED | PRESERVED | No attempt to infer non-entry or retry |
| Artifact inventory before local deletion | v3.6.1 PROPOSED | PROPOSED with defined completeness criteria | A discovery scope/method is described but no real storage census is available |
| `LOCAL_DELETION_COMPLETED` means bounded local scope only | v3.6.1 CORRECTED | PRESERVED with stricter inventory/guard gate | Does not claim absolute irrecoverability or provider deletion |
| Journal is sole admission authority; projection is derived | v3.6 PRESERVED | PRESERVED | Projection remains non-authoritative |
| Projection watermark/current-head consistency and crash recovery | v3.6.1 MODIFIED/clarified | CORRECTED/clarified | Additional explicit stale/lost/corrupt/ahead/crash behavior; implementation remains unresolved |
| v1.0-v3.3 exact decision history | UNRESOLVED in available docs | UNRESOLVED | Original source documents were not available; no release attribution is invented |

### 7.2 Historical decision source rule

The available documents directly support some principles in v3.4-v3.6.1, including Coordinator Journal ordering, no success from `STARTED`, fail-closed recovery, witness-first deletion, metadata privacy as a risk, bitemporal semantics supplied in later consolidated history, and separate send/delivery. The exact original release for most v1.0-v3.3 decisions remains **UNRESOLVED**. Statements in later documents that they “preserve” a decision are traceability assertions, not independent proof of the absent original source.

The v3.6 historical matrix and v3.6.1 correction matrix remain incorporated by reference. This table records only the v3.6.2 changes; it does not silently replace their historical evidence.

## 8. Source Integrity, Blockers and Final Status

### 8.1 Source damage and conflict

The current v3.6 title is malformed: `# Delivery Gate | The only component permitted to invoke a Resu Jarvis Memory Architecture v3.6`. The v3.6 Section 3 component table also contains the malformed row `|lt Delivery Adapter. Applies the same ordering and fencing rules as Egress Gate.` v3.6.1 recorded these and did not repair them. v3.6.2 does not repair or infer their intended text. The damaged component row limits confidence in the exact component inventory, though intact sections separately discuss Delivery Gate behavior. If a decision depends on the missing component wording, it remains **UNRESOLVED**.

A relevant state conflict also remains documented: v3.6.1 says `SEND_STARTED` is local only, while v3.6 Section 22.2 classifies an operation after `*_STARTED` with no receipt as `*_OUTCOME_UNKNOWN`. v3.6.2 corrects this by making classification depend on evidence of dispatch claim, Gate fencing, and Adapter/network boundaries. The source documents do not prove that the proposed evidence is available in an implementation.

### 8.2 Remaining blockers

- **BLOCKER-362-01 Classification:** confirm the official project-wide meanings and usage of `PRESERVED`, `MODIFIED`, `CORRECTED`, `PROPOSED`, and `UNRESOLVED`; exact historical provenance remains incomplete.
- **BLOCKER-362-02 Consolidation privacy:** approve metadata store boundary, access roles, job terminal states, retention and backup treatment, and any cryptographic construction before persistence.
- **BLOCKER-362-03 Pre-claim stop:** prove how the Coordinator/Gate fences the stopped worker and establishes no claim is pending before recording a pre-Adapter cancellation; otherwise preserve uncertainty and do not retry.
- **BLOCKER-362-04 Adapter/network evidence:** select and review instrumentation and receipt contracts for local entry, network initiation, remote receipt, and outcome; no stage can be inferred from its predecessor.
- **BLOCKER-362-05 Deletion inventory:** approve a complete scope/discovery-source census and a privacy-protective inventory record; unknown/uninspected required locations block `LOCAL_DELETION_COMPLETED`.
- **BLOCKER-362-06 Restore guard:** prove all declared backup/recovery paths apply current tombstones and key floors before visibility; no absolute non-restorability claim without a technical basis.
- **BLOCKER-362-07 Inventory retention/privacy:** approve roles, storage protection, retention and backup rules for detailed deletion inventory records.
- **BLOCKER-362-08 Projection consistency:** choose no technology by implication; provide a reviewed transaction/isolation proof for current Journal head, projection watermark, and Fencing Generation at decision commit. Until then, fail closed when consistent state cannot be established.
- **BLOCKER-362-09 Source integrity:** recover an authoritative clean v3.6 artifact if decisions require the damaged title or component row. Do not repair by inference.
- **BLOCKER-362-10 External dependencies and RPO:** Witness contract, RPO, anchor interval/count, provider receipts/deletion contract, crypto profile, and recovery-source decisions previously left open remain blockers.
- **BLOCKER-362-11 Historical provenance:** original v1.0-v3.3 documents/revision history remain unavailable.

### 8.3 Final status

**Architectural Consistency Correction — Not Approved for Implementation.**

v3.6.2 corrects documentation-level inconsistencies and makes evidence limits explicit. It does not prove transaction atomicity, Gate fencing, inventory completeness, restore enforcement, privacy, erasure, or external outcomes. Phase A and Phase B remain unauthorized. This document does not authorize implementation, tests, simulation, database access, deletion, encryption, or external service calls.
