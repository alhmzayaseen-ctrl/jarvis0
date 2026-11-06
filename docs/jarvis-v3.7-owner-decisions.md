# Jarvis v3.7 — Owner Decision Register

## Executive Summary

| ID | Topic | Priority | Recommendation | Needs owner decision? | Needs technical evidence? | Status |
|---|---|---|---|---|---|---|
| D-01 | Decision classification semantics | P2 | Integrated Decision Classification System (proposed principle) | Yes | No | PROPOSED (owner-approved documentation principle) |
| D-02 | Consolidation metadata privacy | P0 | Protected Store + Least Privilege + Retention Policy (proposed principle) | Yes | Yes | PROPOSED |
| D-03 | Pre-claim stop / Gate fencing | P0 | Lease + Fencing Token + Admission Barrier + Fail Closed (proposed principle) | Yes | Yes | PROPOSED |
| D-04 | Adapter/network evidence stages | P0 | Integrated Evidence Architecture (proposed principle) | Yes | Yes | PROPOSED |
| D-05 | Deletion inventory completeness | P0 | Integrated Deletion Inventory Governance (proposed principle) | Yes | Yes | PROPOSED |
| D-06 | Restore guard proof | P0 | Integrated Restore Guard Architecture (proposed principle) | Yes | Yes | PROPOSED |
| D-07 | Inventory retention/privacy | P1 | Integrated Retention & Privacy Governance (proposed principle) | Yes | Yes | PROPOSED |
| D-08 | Projection transaction proof | P0 | Integrated consistency design (proposed principle) | Yes | Yes | PROPOSED |
| D-09 | Damaged v3.6 source | P1 | Source Integrity Preservation (proposed principle) | Yes | Yes | PROPOSED |
| D-10 | External deps/RPO/Witness | P0 | Integrated External Dependency Governance (proposed principle) | Yes | Yes | PROPOSED |
| D-11 | Historical provenance | P2 | Mark UNRESOLVED, no attribution | Yes | Yes | UNRESOLVED |
| D-12 | Protected store crypto construction | P0 | Integrated Cryptographic Protection (proposed principle) | Yes | Yes | PROPOSED |
| D-13 | Access roles/enforcement | P1 | Design proposal only | Yes | Yes | PROPOSED |

## Decision Details

### D-01 Decision classification semantics
Current: owner selected Integrated Decision Classification System as a proposed architectural principle only, not implementation approval.
Why: inconsistent usage across v3.4-v3.6.2; no clear separation between decision lifecycle status and change classification/historical disposition.
Options: (1) two independent dictionaries with distinct functions and cross-applicability; (2) single merged dictionary (rejected — conflates adoption state with historical change); (3) no classification (rejected — creates ambiguity).
Recommended: adopt two independent dictionaries as PROPOSED principle; document function of each, cross-applicability, transition rules, and proof gates.
Advantages: consistency, auditability, prevents premature implementation adoption; Risk: owner decision burden, documentation overhead.
Evidence: lifecycle status proof; change classification proof; cross-application matrix proof; implementation-adoption gate proof (requires evidence + owner approval).
Verification: doc audit for dictionary separation, state transition audit, change classification consistency audit (future).
Owner decision: Approve two-dictionary classification system as proposed (not implementation)?
Status: PROPOSED.

Dictionary 1 — Decision Lifecycle Status (adoption state):
- OWNER_DECISION: a choice explicitly made by the project owner (direction selected, not implementation approval).
- PROPOSED: an architectural principle recommended or selected, requiring technical evidence before implementation.
- TECHNICAL_EVIDENCE_REQUIRED: a decision that cannot proceed until specific technical proof is provided.
- APPROVED_FOR_IMPLEMENTATION: an owner-approved decision with sufficient technical evidence, authorized for implementation. Requires: owner approval + technical evidence + acceptance criteria met.
- UNRESOLVED: available sources do not establish an answer; remains a blocker; no assumption fills the gap.
- REJECTED: a decision that was considered and rejected. Original text, reason, and date preserved.
- SUPERSEDED: a decision replaced by a later decision. Original text, reason, replacement decision ID, and date preserved.

Dictionary 2 — Change Classification / Historical Disposition (what changed relative to history):
- PRESERVED: a documented or supplied requirement is carried forward without changing its meaning. This label does not prove implementation.
- MODIFIED: an existing requirement's scope or semantics is intentionally changed or narrowed. The prior rule, new rule, and reason must be stated.
- CORRECTED: an internal contradiction or ambiguity is resolved by explicitly distinguishing meanings or states, without weakening a separate existing guarantee. The precise inconsistency and corrected interpretation must be traceable.
- PROPOSED: a new mechanism or procedure is suggested, but is not an approved historical decision or selected implementation.
- UNRESOLVED: available sources do not establish an answer or evidence sufficient to make the claim. It remains a blocker; no assumption fills the gap.

Cross-applicability: a single decision can carry one lifecycle status AND one change classification independently. Example: a decision can be PROPOSED (lifecycle: not yet implemented) and MODIFIED (change: its scope was narrowed from a prior version) simultaneously. PROPOSED in either dictionary does NOT imply APPROVED_FOR_IMPLEMENTATION. Owner selection of a direction is not implementation authorization. Phase A/B remain unauthorized until explicit owner approval with technical evidence.

State transitions (lifecycle):
- OWNER_DECISION → PROPOSED: owner selects a direction; no implementation authorization.
- PROPOSED → TECHNICAL_EVIDENCE_REQUIRED: technical proof needed before further progress.
- TECHNICAL_EVIDENCE_REQUIRED → APPROVED_FOR_IMPLEMENTATION: evidence provided and owner approves implementation.
- PROPOSED → REJECTED/SUPERSEDED: direction replaced by a later decision; history preserved.
- Any state → UNRESOLVED: insufficient evidence to proceed.
- UNRESOLVED → any other state: only when new evidence or owner decision resolves it.

Rejected/superseded handling: original decision text, reason for rejection/supersession, replacement decision ID, and date are preserved in a decision history log. No silent deletion or weakening of prior guarantees.

Dependents: D-02 through D-13 (all use this classification system; D-01 is the classification foundation and does not depend on any of them).
Guarantee limits: classification is a documentation/audit mechanism, not implementation proof; no state transition is valid without required evidence and approvals; no Phase A/B or implementation authorization.

Owner Approval:
The project owner approved the Integrated Decision Classification
System as a documentation and audit principle only.

Scope:
Documentation and audit only.

Implementation:
No implementation authorization is granted.
Phase A and Phase B remain unauthorized.

Other Decisions:
D-02 through D-13 remain independent and retain
their existing statuses.

Classification:
PROPOSED in either dictionary does not imply
APPROVED_FOR_IMPLEMENTATION.

Independent fields:
lifecycle_status: PROPOSED
owner_approval: APPROVED_DOCUMENTATION_ONLY
implementation_authorized: false

### D-02 Consolidation metadata privacy
Current: owner selected Protected Store + Least Privilege + Retention Policy as a proposed architectural principle only, not implementation approval.
Why: public disclosure risk from consolidation metadata (ranges, hashes, digests, job mappings).
Options: (1) integrated protected store with least privilege, retention policy, data minimization, and audit privacy; (2) no persistence of consolidation metadata; (3) plaintext storage (rejected).
Recommended: adopt Protected Store + Least Privilege + Retention Policy as PROPOSED principle; define store boundary, role model, retention durations, deletion scope; select encryption technology later.
Advantages: privacy; Risk: implementation complexity, key management, retention definition, external service capabilities.
Evidence: store protection proof; least-privilege enforcement proof; retention and deletion application across all data types; no personal data leakage via hashes/digests/ranges/monitoring logs; unauthorized access test results; retention expiry test results; deletion test results; restart/recovery test results; documentation of unprovable items and external capability dependencies.
Verification: unauthorized access, retention expiry, deletion, restart/recovery integration tests (future).
Owner decision: Approve Protected Store + Least Privilege + Retention Policy principle as proposed (not implementation)?
Status: PROPOSED.
Components: Protected Store (sensitive consolidation metadata, not treated as non-sensitive technical data); Least Privilege (minimum components/permissions, purpose-limited access); Retention Policy (need-based durations for consolidation assistant data and protected consolidation metadata belonging to it, deletion when no longer needed; does not cover inventory logs, access logs, or backups governed by D-07); Data Minimization (no auxiliary data beyond task requirements); Sensitive Metadata (ranges/hashes/digests treated as potentially sensitive; hash/digest not assumed safe just because original text is absent); Encryption and Key Management (protection need documented, technology and effectiveness proof open pending evaluation); Audit Privacy (audit/monitoring logs must not reveal memory content or personal information via metadata); Deletion (covers copies, derivatives, temporary data under a clear, provable inventory).
Guarantee limits: technical details are not settled unless proven by evidence; no Phase A/B or implementation authorization.

### D-03 Pre-claim stop / Gate fencing
Current: owner selected integrated Lease + Fencing Token + Admission Barrier + Fail Closed as a proposed architectural principle only, not implementation approval.
Why: duplicate/unknown external effects.
Options: (1) integrated fencing design (Lease, Fencing Token, Admission Barrier, Fail Closed); (2) preserve uncertainty without mechanism; (3) infer non-invocation from missing log (rejected).
Recommended: adopt integrated fencing design as PROPOSED principle; select lease/fencing technology later.
Advantages: safety; Risk: implementation complexity, external service fencing limits.
Evidence: Lease expiry proof; Fencing Token monotonicity and stale-token rejection; Admission Barrier revocation-vs-accept order; concurrent request handling; Coordinator restart; network partition; external timeout; duplicate request; fail-closed behavior; OUTCOME_UNKNOWN preservation.
Verification: Worker Crash, Lease Expiry, Stale Token, Concurrent Revocation, Coordinator Restart, Network Partition, Duplicate Request, External Timeout, Recovery integration tests (future).
Owner decision: Approve integrated fencing principle as proposed (not implementation)?
Status: PROPOSED.
Notes: Local Safety prevents Jarvis from starting a stale operation; External Safety is NOT guaranteed unless the external service itself reliably validates Fencing Tokens. No Phase A/B or implementation authorization. Single transaction does not span separate stores. Fencing and Admission Barrier must govern all external send stages defined by D-04 (DISPATCH_CLAIMED, ADAPTER_INVOCATION_OBSERVED, NETWORK_REQUEST_STARTED, REMOTE_RESPONSE_OBSERVED, REMOTE_ACCEPTED, REMOTE_COMPLETED, OUTCOME_UNKNOWN); no stage is treated as proof of a later stage.

### D-04 Adapter/network evidence stages
Current: owner selected Integrated Evidence Architecture as a proposed architectural principle only, not implementation approval.
Why: false success claims from promoting one stage to another.
Options: (1) Integrated Evidence Architecture (Local Event Journal, Transport Evidence, Remote Receipt, Idempotency + Reconciliation); (2) stage-specific instrumentation without reconciliation; (3) no instrumentation (rejected).
Recommended: adopt Integrated Evidence Architecture as PROPOSED principle; define proposed stage names and evidence sources; select instrumentation technology later.
Advantages: precise evidence separation; Risk: instrumentation burden, external service variability, idempotency not universally supported.
Evidence: clear definition of each stage and its evidence source; durable event journaling resistant to system failure; separation of ADAPTER_INVOCATION_OBSERVED from NETWORK_REQUEST_STARTED; separation of client-side send completion from external receipt; separation of request sending from remote receipt; separation of remote acceptance from remote completion; TCP/HTTP response alone is not proof of operation completion; reliability degree and limits of each evidence type documented; connection loss and stop testing at every stage; duplicate prevention proof on recovery/retry; idempotency and reconciliation support where external service provides it; no automatic retry when outcome is unknown.
Verification: integration tests at each stage (future).
Owner decision: Approve Integrated Evidence Architecture principle as proposed (not implementation)?
Status: PROPOSED.
Proposed stage names: DISPATCH_CLAIMED, ADAPTER_INVOCATION_OBSERVED, NETWORK_REQUEST_STARTED, REMOTE_RESPONSE_OBSERVED, REMOTE_ACCEPTED, REMOTE_COMPLETED, OUTCOME_UNKNOWN. These are proposed labels; not all are provable with equal strength, and not every external service supports them.
Guarantee limits: local evidence alone does not prove external receipt; client-side send completion does not prove external receipt; remote acceptance does not prove remote completion; idempotency cannot be assumed for all services; when sufficient evidence is absent, maintain OUTCOME_UNKNOWN; no automatic retry for uncertain outcomes. No Phase A/B or implementation authorization.

### D-05 Deletion inventory completeness
Current: owner selected Integrated Deletion Inventory Governance as a proposed architectural principle only, not implementation approval.
Why: incomplete erasure claims and unknown/uninspected required locations block deletion completion.
Options: (1) integrated deletion inventory governance (approved scope, discovery sources, complete artifact classes, provable dispositions, unknown locations block completion); (2) best-effort inventory (rejected — incomplete erasure claims); (3) no inventory (rejected — contradicts v3.6/v3.6.2 deletion requirements).
Recommended: adopt Integrated Deletion Inventory Governance as PROPOSED principle; define scope, discovery sources, artifact classes, disposition states, and completion gates; select implementation mechanisms later.
Advantages: correctness; Risk: operational cost, unknown store discovery, backup/key copy coverage, physical media proof.
Evidence: approved scope proof; discovery source proof; complete artifact class proof (Memory Content Store, Projections/Indexes, Temporary Context/Caches, Protected Link Store, Payload Binding Vault, Key Store, Local Backups, Consolidation artifacts, Protected Egress Staging, derivatives); disposition proof per item (REMOVED, CRYPTOGRAPHICALLY_INACCESSIBLE, RETAINED_UNDER_RESTORE_GUARD, UNRESOLVED); unknown location proof (missing result = not absence; blocks LOCAL_DELETION_COMPLETED); verification status proof per item; key/restore revision proof.
Verification: inventory census tests, unknown location handling tests, deletion completion gate tests, backup/key copy discovery tests, restart/recovery inventory tests (future).
Owner decision: Approve Integrated Deletion Inventory Governance principle as proposed (not implementation)?
Status: PROPOSED.
Components: Approved scope (explicitly defined deletion scope, data-location model, enumerated discovery sources); Discovery sources (store, replication, backup, cache, projection inventory); Artifact classes (at minimum: Memory Content Store objects/replicas, projections/indexes/embeddings/derived summaries/rebuild sources, temporary context/caches/spool files, Protected Link Store mappings/replicas, Payload Binding Vault records/keys/references/copies, Key Store generations/wraps/replicas/escrow copies, Local Backups/snapshots/replicas/restore sources, Consolidation proposals/ranges/checkpoints/digests/drafts/intermediate outputs, Protected Egress Staging payloads/receipts, additional discovered copies/derivatives); Disposition states (REMOVED, CRYPTOGRAPHICALLY_INACCESSIBLE, RETAINED_UNDER_RESTORE_GUARD, UNRESOLVED); Location status (INSPECTED, NOT_APPLICABLE_WITH_BASIS, UNINSPECTED, UNRESOLVED; missing result not interpreted as absence); Completion gate (LOCAL_DELETION_COMPLETED forbidden if any required location uninspected/unresolved or evidence missing); Inventory sensitivity (sensitive/linkable operational metadata; minimized fields; no content/plain identifiers/public hashes/detailed personal paths/stable subject IDs in general audit record). Conceptual artifact classes in D-05 do not necessarily map one-to-one with physical storage locations; actual mapping between conceptual classes and physical locations is subject to implementation census and remains UNRESOLVED until verified.
Dependencies: D-02 (consolidation metadata privacy), D-06 (restore guard), D-07 (inventory retention/privacy), D-12 (crypto protection), D-03 (pre-claim stop/fencing).
Guarantee limits: inventory complete only relative to approved scope/discovery sources; not a claim that undiscovered media or every physical bit has been found; no absolute irrecoverability claim without technical basis; no claim that provider-side deletion occurred; no automatic retry without new authorization; no Phase A/B or implementation authorization.

### D-06 Restore guard proof
Current: owner selected Integrated Restore Guard Architecture as a proposed architectural principle only, not implementation approval.
Why: backup revival risk.
Options: (1) integrated restore guard (Tombstone, Generation/Epoch, Cryptographic Erasure, Restore Quarantine); (2) evidence-list guard without integrated components; (3) policy-only guard (rejected).
Recommended: adopt Integrated Restore Guard Architecture as PROPOSED principle; define component responsibilities and evidence boundaries; select implementation technology later.
Advantages: safety; Risk: proof complexity, key inventory scope, backup revival edge cases.
Evidence: Tombstone independence from old backups; non-regression of Generation after restart/restore; complete key inventory and verified destruction; all restore paths pass through Quarantine; failure/interruption keeps data isolated.
Verification: tests covering old backups, missing Tombstone, old Generation, surviving key, interrupted restore, multiple backups, and restart (future).
Owner decision: Approve Integrated Restore Guard principle as proposed (not implementation)?
Status: PROPOSED.
Components: Tombstone (reliable, independent of old backups, idempotent, no deleted personal content); Generation/Epoch (trusted security generation that does not regress on restore, prevents revival of deleted data/permissions/keys); Cryptographic Erasure (destruction of all related key copies with documented inventory of storage locations, backups, and derived artifacts); Restore Quarantine (isolate any restored copy, prevent visibility/use until integrity verified and deletion records applied).
Inventory scope: SQLite, Event Journal, files, caches, indexes, Consolidation data, backups, key stores, and derived artifacts.
Dependencies: D-05 (deletion inventory scope), D-12 (cryptographic erasure and key destruction).
Physical location mapping: physical locations listed above (SQLite, Event Journal, files, caches, indexes, Consolidation data, backups, key stores, derived artifacts) are candidate storage locations; their correspondence to D-05 conceptual artifact classes is subject to implementation census and remains UNRESOLVED until verified.
Guarantee limits: if restore integrity or deletion completeness cannot be proven, the copy remains isolated and may not be used, displayed, or declared as successful restoration. No Phase A/B or implementation authorization.

### D-07 Inventory retention/privacy
Current: owner selected Integrated Retention & Privacy Governance as a proposed architectural principle only, not implementation approval.
Why: deletion inventory records, backup copies, audit history, and access history are sensitive and potentially linkable; retention durations and access rules remain unresolved.
Options: (1) integrated retention & privacy governance (purpose-limited retention, least privilege, audit isolation, backup inclusion in inventory, deletion of copies/derivatives/temporary data, no permanent detailed inventory without owner approval); (2) permanent retention (rejected — contradicts privacy minimization); (3) no retention policy (rejected — leaves deletion inventory ungoverned).
Recommended: adopt Integrated Retention & Privacy Governance as PROPOSED principle; define retention durations per data class, access roles, audit isolation, backup treatment, and deletion scope; select implementation mechanisms later.
Advantages: privacy; Risk: implementation complexity, audit needs, backup revival edge cases, owner decision burden on retention durations.
Evidence: retention policy proof (durations per data class, deletion when no longer needed); least-privilege access proof (roles, purpose limitation, audited access); audit isolation proof (access audit does not duplicate personal location/content details); backup inclusion proof (inventory backups covered by restore guard); deletion scope proof (copies, derivatives, temporary data included in provable inventory); no permanent detailed inventory without owner approval proof.
Verification: unauthorized access tests, retention expiry tests, deletion tests, backup inclusion tests, audit log isolation tests, restart/recovery retention tests (future).
Owner decision: Approve Integrated Retention & Privacy Governance principle as proposed (not implementation)?
Status: PROPOSED.
Components: Purpose-limited retention (each data class under D-07 governance has need-based duration, deleted when no longer needed; covers deletion inventory records, backup copies, audit history, and access history; does not cover consolidation metadata governed by D-02); Least privilege access (authorized deletion/recovery personnel and Coordinator deletion verifier only, purpose-limited and audited); Audit isolation (access audit minimized, does not duplicate personal details); Backup treatment (inventory backups included in deletion inventory and governed by restore guard per D-06); Deletion scope (covers copies, derivatives, temporary data under clear provable inventory per D-05); Owner decision gate (no permanent detailed inventory or direct personal mapping without explicit owner approval).
Dependencies: D-02 (consolidation metadata retention), D-05 (deletion inventory scope), D-06 (restore guard/backup policy), D-12 (crypto protection for inventory records).
Guarantee limits: retention durations are owner decisions, not technical defaults; least privilege is a design proposal until enforcement is proven; audit isolation does not prove unlinkability; backup treatment depends on restore guard verification; no Phase A/B or implementation authorization.

### D-08 Projection transaction proof
Current: fail-closed; no storage proof. Owner selected integrated Journal/Projection consistency as a proposed architectural principle only, not implementation approval.
Why: authorization errors.
Options: (1) integrated consistency design (Journal sole truth, atomic transaction where store supports it, version/watermark, consistent read, fail-closed); (2) assume atomicity (rejected); (3) watermark-only trust (rejected).
Recommended: adopt integrated consistency design as PROPOSED principle; select storage/transaction technology later.
Advantages: safety; Risk: implementation complexity, unproven storage atomicity.
Evidence: atomicity, consistency, concurrency, stale snapshots, watermark correctness, crash/recovery, fail-closed behavior.
Verification: consistency tests (future).
Owner decision: Approve integrated consistency principle as proposed (not implementation)?
Status: PROPOSED.
Notes: Storage technology and final transaction mechanism UNRESOLVED. Atomic transaction boundaries depend on actual store boundaries (see D-02 for Protected Store boundary); a single transaction does not guarantee atomicity across separate stores. Watermark match alone is insufficient proof of Projection correctness. No Phase A/B or implementation authorization.

### D-09 Damaged v3.6 source
Current: owner selected Source Integrity Preservation as a proposed architectural principle only, not implementation approval.
Why: v3.6 source contains visible text damage (malformed title line: `# Delivery Gate | The only component permitted to invoke a Resu Jarvis Memory Architecture v3.6`; malformed component row in Section 3: `|lt Delivery Adapter. Applies the same ordering and fencing rules as Egress Gate.`). v3.6.1 recorded these and did not repair them. v3.6.2 does not repair or infer their intended text. The damaged component row limits confidence in the exact component inventory.
Options: (1) source integrity preservation (no inference or repair of damaged text; recover authoritative artifact if decisions depend on it; otherwise scope decisions to intact text); (2) infer intended text (rejected — violates v3.6/v3.6.2 no-inference rule); (3) ignore damage (rejected — leaves component inventory uncertain).
Recommended: adopt Source Integrity Preservation as PROPOSED principle; record damage explicitly; recover clean v3.6 source if any decision depends on the damaged title or component row; otherwise treat affected claims as UNRESOLVED.
Advantages: clarity, honesty about source limits; Risk: source availability, component inventory uncertainty for damaged row.
Evidence: authoritative clean v3.6 artifact (if recovered); source audit proof; documentation of which decisions depend on damaged text; UNRESOLVED marking for affected claims.
Verification: source audit, comparison against intact sections, decision dependency analysis (future).
Owner decision: Approve Source Integrity Preservation principle as proposed (not implementation)? Approve recovery effort for clean v3.6 source?
Status: PROPOSED.
Components: Damage record (malformed title, malformed component row); No-inference rule (do not reconstruct damaged text by guessing); Recovery gate (recover authoritative artifact only if decisions depend on damaged text); UNRESOLVED scoping (affected claims remain UNRESOLVED until clean source recovered).
Dependencies: D-03 (component inventory affects fencing/Gate), D-04 (component table affects Adapter evidence), D-05 (component inventory affects deletion), D-06 (component inventory affects restore), D-08 (component inventory affects projection), D-10 (component inventory affects external deps), D-12 (component inventory affects crypto), D-13 (component inventory affects roles).
Guarantee limits: recovery effort is an owner decision; damaged text cannot be reconstructed by inference; affected component claims remain UNRESOLVED until clean source recovered; no Phase A/B or implementation authorization.

### D-10 External deps/RPO/Witness
Current: owner selected Integrated External Dependency Governance as a proposed architectural principle only, not implementation approval.
Why: external guarantees (Witness contract, RPO, anchor interval, provider receipts/deletion contract, crypto profile, recovery source) remain open blockers before Phase B and external memory use.
Options: (1) integrated external dependency governance (Witness contract terms, RPO values, anchor cadence, provider/deletion contracts, recovery source, fail-closed behavior); (2) proceed without contracts (rejected — external guarantees unproven); (3) assume provider deletion/receipt semantics (rejected — not evidence).
Recommended: adopt Integrated External Dependency Governance as PROPOSED principle; define contract boundaries, RPO/Witness terms, provider/deletion evidence rules, and fail-closed behavior; select specific providers/contracts later.
Advantages: clarity; Risk: delay, external service variability, contract negotiation burden.
Evidence: Witness contract proof (anchor, idempotency, status query, monotonicity, retention, outage behavior); RPO proof (maximum recoverable event loss, max unanchored events, anchor interval, outage/re-entry policies); provider/deletion contract proof (receipt semantics, deletion evidence, unknown-outcome policy); recovery source proof (authenticated journal replica); fail-closed proof (deletion/restore/key release/visibility fail closed if Witness proof absent/stale).
Verification: Witness idempotency tests, anchor/reconciliation tests, RPO/DR tests, provider receipt tests, external deletion evidence tests, fail-closed behavior tests (future).
Owner decision: Approve Integrated External Dependency Governance principle as proposed (not implementation)?
Status: PROPOSED.
Components: Witness contract (anchor operation, manifest digest, monotonic Witness Revision, status query by operation ID, no conflicting tombstones); RPO policy (maximum event loss, unanchored event cap, anchor interval, trusted-time definition); Provider/deletion contracts (authenticated receipt contract, provider deletion evidence meaning, unknown-outcome preservation); Recovery source (current authenticated journal replica, hash cannot reconstruct missing entries); Fail-closed (Visibility Gate, Adapter access, key unwrap, result delivery closed until Witness/tombstone/key floor proofs pass).
Dependencies: D-03 (fencing/fail-closed), D-04 (external receipt evidence), D-06 (restore guard/Witness anchor), D-07 (backup treatment), D-12 (crypto protection).
Guarantee limits: RPO values are owner decisions, not technical defaults; Witness guarantees not claimed until contract selected and reviewed; provider deletion not implied by local deletion; external service cryptography/retention/residency not controlled by Jarvis; hash-only Witness anchor cannot reconstruct missing journal entries; no Phase A/B or implementation authorization.

### D-11 Historical provenance
Current: v1.0–v3.3 source documents remain unavailable after project-wide search.
Why: attribution uncertainty. No original v1.0–v3.3 architecture documents exist in the project.
Search conducted:
- Glob pattern `**/*v1*`: no files found.
- Glob pattern `**/*v2*`: no files found.
- Glob pattern `**/*v3.{0,2}*`: no files found.
- Git log --all --oneline: only agent host session checkpoints (turns 1–58 and baseline checkpoints); no original architecture document commits.
- Git diff-filter=D for deleted docs/*v3*: no deleted version documents found.
- Git tags: none.
- Git branches: classic-attempt, heather-dust, lackadaisical-curtain, master, potent-sword, tar-grenadilla — none contain v1.0–v3.3 source documents.
- Available architecture documents: v3.4, v3.5, v3.6, v3.6.1, v3.6.2, v3.7 only.

Inventory of sources found:
| Source | Path | What can be proven | What cannot be proven |
|---|---|---|---|
| v3.4 | docs/jarvis-memory-architecture-v3.4.md | Document exists and is readable | Original v1.0–v3.3 content |
| v3.5 | docs/jarvis-memory-architecture-v3.5.md | Document exists and is readable | Original v1.0–v3.3 content |
| v3.6 | docs/jarvis-memory-architecture-v3.6.md | Document exists (with known title/component damage) | Original v1.0–v3.3 content |
| v3.6.1 | docs/jarvis-memory-architecture-v3.6.1.md | Document exists and is readable | Original v1.0–v3.3 content |
| v3.6.2 | docs/jarvis-memory-architecture-v3.6.2.md | Document exists and is readable | Original v1.0–v3.3 content |
| v3.7 | docs/jarvis-memory-architecture-v3.7.md | Document exists and is readable | Original v1.0–v3.3 content |
| Git history | .git/ | Agent session checkpoints only | No v1.0–v3.3 architecture documents |

Options: (1) keep UNRESOLVED; (2) invent attribution (rejected — no verifiable source).
Recommended: keep UNRESOLVED. No original v1.0–v3.3 documents can be restored, reconstructed, or attributed. Any historical claim about v1.0–v3.3 must be marked as user-supplied history, not verified original specification.
Advantages: honesty, no false attribution; Risk: incomplete historical record.
Evidence: original docs (unavailable).
Verification: provenance review (cannot be completed without original sources). Code tests and technical evidence cannot prove historical content that does not exist in available sources; resolution requires archival source recovery, which is an owner decision separate from technical evidence.
Owner decision: Accept UNRESOLVED status for v1.0–v3.3 provenance?
Status: UNRESOLVED.
Dependencies: D-01 (classification system treats v1.0–v3.3 claims as user-supplied history, not verified). D-09 (source integrity preservation — damaged v3.6 text unrelated to missing v1.0–v3.3).
Guarantee limits: no decision about v1.0–v3.3 can be attributed to a specific version without original source proof. No Phase A/B or implementation authorization.

### D-12 Protected store crypto construction
Current: owner selected Integrated Cryptographic Protection as a proposed architectural principle only, not implementation approval.
Why: consolidation metadata (ranges, hashes, digests, job mappings) must be protected at rest; no cryptographic suite, key management, or erasure proof has been selected or validated.
Options: (1) integrated cryptographic protection (key domain separation, per-operation keying, AEAD, nonce safety, key lifecycle, cryptographic erasure, audit isolation); (2) defer crypto until persistence (rejected — persistence without protection is a privacy risk); (3) plaintext protected store (rejected — contradicts D-02 and v3.6.2 privacy rules).
Recommended: adopt Integrated Cryptographic Protection as PROPOSED principle; define key domains, construction, lifecycle, and erasure boundaries; select specific suite/module later.
Advantages: privacy; Risk: implementation complexity, key custody, nonce management, external service crypto variability, proof of key destruction.
Evidence: key domain separation proof (consolidation metadata keys distinct from content keys and audit MAC keys); per-operation keying proof; AEAD construction proof; nonce non-reuse proof; key lifecycle proof (creation, rotation, destruction); cryptographic erasure proof (destroying keys renders associated ciphertext inaccessible); audit isolation proof (journal/Witness/monitoring logs contain no content-derived digests or metadata fingerprints); backup revival prevention proof (old backups cannot restore/reactivate keys).
Verification: key domain isolation tests, encryption/decryption tests, key destruction verification, backup revival prevention tests, access control tests, audit log review, restart/recovery crypto tests (future).
Owner decision: Approve Integrated Cryptographic Protection principle as proposed (not implementation)?
Status: PROPOSED.
Components: Key domain separation (three independent domains: consolidation metadata, content DEKs, audit MACs); per-operation keying (fresh random key per consolidation job/operation); AEAD encryption (authenticated encryption with associated data binding operation scope, format, and key generation); nonce safety (never reuse key+nonce pair; retries reuse existing ciphertext); key lifecycle (creation under approved domain, rotation on compromise/schedule, destruction on deletion/terminal state); cryptographic erasure (key destruction makes ciphertext cryptographically inaccessible; physical erasure not claimed); audit isolation (no plaintext or content-derived fingerprint in journal/Witness/audit/monitoring logs).
Guarantee limits: encryption does not hide size, timing, cadence, or metadata correlation; key destruction is not physical erasure; absolute unlinkability not claimed; external service cryptography not controlled by Jarvis; no Phase A/B or implementation authorization.

### D-13 Access roles/enforcement
Current: proposed roles.
Why: enforcement unproven.
Options: implement roles; document only.
Recommended: design now, prove later.
Advantages: clarity; Risk: no enforcement yet.
Evidence: implementation proof.
Verification: access audit.
Owner decision: Approve role model?
Status: PROPOSED.
Components: role names, permission sets, and access rules are not specified in current text; role model definition is OWNER DECISION REQUIRED.
Dependencies: None identified (role model scope and enforcement boundaries remain UNRESOLVED until owner defines roles).
Guarantee limits: no role names, permission sets, or access rules are confirmed; enforcement mechanism is UNRESOLVED; least privilege is a design proposal until proven; no Phase A/B or implementation authorization.

## Summary Counts

- Total decisions: 13
- P0: D-02, D-03, D-04, D-05, D-06, D-08, D-10, D-12 (8)
- P1: D-07, D-09, D-13 (3)
- P2: D-01, D-11 (2)
- Need owner approval: all 13
- Need technical evidence: D-02, D-03, D-04, D-05, D-06, D-07, D-08, D-09, D-10, D-11, D-12, D-13
- Status breakdown: PROPOSED = 12 (D-01, D-02, D-03, D-04, D-05, D-06, D-07, D-08, D-09, D-10, D-12, D-13); UNRESOLVED = 1 (D-11)

## Recommended Resolution Order

1. D-01, D-08, D-03 (classification foundation, core consistency/safety)
2. D-04, D-06 (evidence)
3. D-02, D-12, D-07 (privacy)
4. D-05, D-10 (deletion/external)
5. D-09, D-11, D-13 (source/historical/roles)

## Risks If Delayed

Unknown external effects, backup revival, privacy leakage, inconsistent admission, unverified deletion, unresolved historical attribution. No decision assumed approved.

## ملحق أ — دراسة تصميمية: العلاقة بين Protected Store (D-02) وCoordinator Journal (D-08)

### أ.1 غرض الدراسة

تحليل أنماط تحقيق الاتساق بين Coordinator Journal (مصدر الحقيقة الوحيد) وProtected Store (المخزن المحمي لبيانات Consolidation المساعدة من D-02)، مع توضيح الضمانات والحدود لكل نمط. هذه الدراسة غير معتمدة للتنفيذ، وكل خيار يحتاج موافقة مالك المشروع قبل الاعتماد.

### أ.2 الأنماط المقارنة

#### النمط 1: قاعدة بيانات واحدة مع معاملات ذرية

**الوصف:** يخزن Coordinator Journal وProtected Store في نفس قاعدة البيانات ضمن المخزن الفيزيائي نفسه، وتتم كتابة الحدث في Journal والبيانات الوصفية في Protected Store ضمن معاملة واحدة على محرك قاعدة البيانات.

| المعيار | التقييم |
|--------|---------|
| Atomicity | ذرية ضمن ضمانات محرك قاعدة البيانات للمخزن الواحد |
| Consistency | قوي ضمن حدود قاعدة البيانات الواحدة |
| سلوك التعطل بين الكتابات | rollback للمعاملة بأكملها إذا تعطلت قبل commit |
| Idempotency | يدعم عبر المعرف الفريد للحدث |
| الاستعادة | إعادة بناء من Journal |
| توافق Append-only Journal | مباشر |
| توافق Privacy Gateway | يحتاج فصل منطقي أو تشفير على مستوى العمود لحماية البيانات الوصفية |
| توافق Cryptographic Erasure | إتلاف المفاتيح يجعل البيانات في Protected Store غير قابلة للقراءة |
| أثر على الحذف والنسخ الاحتياطية | النسخ الاحتياطي يشمل كلاهما معاً ضمن نفس قاعدة البيانات |
| التعقيد التشغيلي | منخفض نسبياً |
| ما يمكن إثباته محلياً | معاملة قاعدة البيانات |
| ما يعتمد على خدمة خارجية | لا شيء |

**تسلسل الكتابة والتعطل والاستعادة:**
```
تطبيق: BEGIN TX → escribir Journal commit_sequence=100
        → escribir Protected Store range_hash, checkpoint
        → COMMIT TX
        ↓ (تعطل قبل COMMIT)
تطبيق: rollback تلقائي للمعامل → لا événement في Journal، لا بيانات في Protected Store
        ↓ (استعادة)
تطبيق: إعادة قراءة Journal، لا يوجد commit_sequence=100، العملية لم تحدث
```

**القيود:** لا يمكن ضمان العزل الفيزيائي للبيانات الوصفية الحساسة داخل نفس قاعدة البيانات ما لم يتم التشفير على مستوى العمود أو الجدول. الفصل هنا Logical وليس Physical ما لم يُستخدم تشفير منفصل.

---

#### النمط 2: مخازن منفصلة مع Transactional Outbox/Inbox

**الوصف:** Coordinator Journal وجدول Outbox في مخزن واحد وتُكتب في معاملة واحدة. Protected Store في مخزن منفصل. عملية منفصلة تنقل من Outbox إلى Protected Store.

| المعيار | التقييم |
|--------|---------|
| Atomicity | ذرية داخل كل مخزن على حدة (Journal+Outbox في معاملة واحدة)، ليست ذرية بين المخازنين |
| Consistency | Eventual consistency بين Journal وProtected Store |
| سلوك التعطل بين الكتابات | لا يمكن أن يُحفظ Journal بدون Outbox (نفس المعاملة). إذا تعطل بعد commit قبل النقل إلى Protected Store: السجل في Journal موجود، البيانات غير منقولة إلى Protected Store |
| Idempotency | معرّف حدث فريد في Outbox ومنقول إلى Protected Store، المعالجة idempotent |
| الاستعادة | إعادة تشغيل معالج Outbox، إعادة المحاولة idempotently |
| توافق Append-only Journal | مباشر، Outbox يُضاف إليه كجدول مساعد |
| توافق Privacy Gateway | Outbox يحتوي على مراجع محمية، يحتاج تشفير |
| توافق Cryptographic Erasure | إتلاف المفاتيح في Protected Store يجعل بياناته غير قابلة للقراءة،但 Outbox قد يحتفظ بمراجع غير حساسة |
| أثر على الحذف والنسخ الاحتياطية | نسخ احتياطية منفصلة لكل مخزن، تحتاج تنسيق |
| التعقيد التشغيلي | متوسط إلى مرتفع |
| ما يمكن إثباته محلياً | committing Journal+Outbox، committing Protected Store |
| ما يعتمد على خدمة خارجية | المعالج الذي ينقل من Outbox إلى Protected Store (إذا كان خارجياً) |

**تسلسل الكتابة والتعطل والاستعادة:**
```
تطبيق: [TX1] escribir Journal seq=100 + escribir Outbox(id=E1, status=PENDING) COMMIT TX1
        ↓ (تعطل قبل تشغيل المعالج)
معالج: إعادة تشغيل، قراءة Outbox PENDING، escribir في Protected Store، تحديث Outbox status=DONE
        ↓ (تعطل بعد escribir في Protected Store قبل تحديث Outbox)
معالج: إعادة تشغيل، قراءة Outbox PENDING، المحاولة idempotent، الكتابة في Protected Store تُتجاهل إذا كان E1 موجوداً
```

**القيود:** لا يوجد ضمان ذري بين المخازنين. الفجوة بين كتابة Journal ونقل البيانات إلى Protected Store يمكن أن تترك حالة غير متسقة مؤقتاً.

---

#### النمط 3: مخازن منفصلة مع Saga أو آلية تعويض

**الوصف:** كل عملية تكتب في مخزنها الخاص، وتستخدم Saga مع خطوات تعويض (compensating transactions) إذا فشلت أي خطوة.

| المعيار | التقييم |
|--------|---------|
| Atomicity | غير مضمونة، نموذج Saga هو eventual consistency |
| Consistency | متوافقة مؤقتاً، قد تكون غير متسقة أثناء تنفيذ Saga |
| سلوك التعطل بين الكتابات | إذا تعطلت خطوة، يتم تشغيل خطوات تعويض للخطوات السابقة |
| Idempotency | كل خطوة Saga تحتاج معرّف فريد، خطوات التعويض need idempotency |
| الاستعادة | إعادة تشغيل Saga من النقطة الأخيرة المعروفة |
| توافق Append-only Journal | مراحل Saga تُضاف كأحداث في Journal |
| توافق Privacy Gateway | خطوات التعويض قد تنقل بيانات حساسة، تحتاج حذر |
| توافق Cryptographic Erasure | خطوات التعويض قد تترك آثاراً في المخازن، تحتاج معالجة خاصة |
| أثر على الحذف والنسخ الاحتياطية | معقد، كل مخزن له نسخ احتياطية منفصلة |
| التعقيد التشغيلي | مرتفع |
| ما يمكن إثباته محلياً | إكمال كل خطوة Saga |
| ما يعتمد على خدمة خارجية | منسق Saga إذا كان خارجياً |

**تسلسل الكتابة والتعطل والاستعادة:**
```
خطوة 1: escribir في Journal seq=100 (ناجح)
خطوة 2: escribir في Protected Store (فشل)
        ↓ (تشغيل تعويض)
تعويض 1: escribir حدث إلغاء في Journal seq=101
        ↓ (تعطل قبل إكمال التعويض)
استعادة: قراءة Journal، اكتشاف seq=100 بدون seq=101، تشغيل التعويض مرة أخرى
```

**القيود:** التعويض لا يعادل التراجع الذري. البيانات قد تكون كتبت في المخزن الأول قبل التعويض. لا يمكن إلغاء ما كتب فعلياً.

---

#### النمط 4: Journal كمصدر حقيقة مع كتابة قابلة للاستئناف وإعادة بناء البيانات المشتقة فقط

**الوصف:** Coordinator Journal هو المخزن الوحيد الموثوق للقرارات. Protected Store يُعتبر derived data يُعاد بناؤه من الأحداث في Journal **فقط إذا كانت الأحداث تحتوي على جميع البيانات اللازمة لإعادة البناء**. إذا كانت البيانات الأصلية أُتلفت أو حُذفت نهائياً، لا يمكن استرجاعها.

| المعيار | التقييم |
|--------|---------|
| Atomicity | ذرية فقط في Journal |
| Consistency | قوي في Journal، Protected Store يُعاد بناؤه إذا أمكن |
| سلوك التعطل بين الكتابات | إذا تعطل بعد Journal وقبل Protected Store: Protected Store مفقود، يُعاد بناؤه من Journal فقط إذا كانت البيانات متاحة |
| Idempotency | إعادة البناء من Journal تُطبق idempotently بواسطة معرف الحدث |
| الاستعادة | إعادة بناء Protected Store من الأحداث في Journal (إذا كانت البيانات كافية) |
| توافق Append-only Journal | طبيعي ومباشر |
| توافق Privacy Gateway | Journal يحتوي فقط على مراجع غير حساسة، البيانات الفعلية في Protected Store مشفرة |
| توافق Cryptographic Erasure | إتلاف المفاتيح في Protected Store يجعل بياناته غير قابلة للقراءة؛ لا يمكن استرجاع البيانات المحذوفة أو المدمرة المفاتيح |
| أثر على الحذف والنسخ الاحتياطية | نسخة احتياطية واحدة من Journal تكفي للقرارات، Protected Store يُعاد بناؤه أو يُترك مع المفاتيح المتلفة |
| التعقيد التشغيلي | متوسط |
| ما يمكن إثباته محلياً | Commit في Journal |
| ما يعتمد على خدمة خارجية | عملية إعادة البناء (إذا كانت خارجية) |

**تسلسل الكتابة والتعطل والاستعادة:**
```
تطبيق: escribir evento en Journal seq=100 con referencia a Protected Store
        ↓ (تعطل antes de escribir en Protected Store)
استعادة: leer Journal, evento seq=100 existe
        → إذا كانت البيانات متاحة في الحدث أو مصدر موثوق آخر: إعادة بناء Protected Store
        → إذا كانت البيانات مفقودة أو المفاتيح تالفة: لا يمكن الاسترجاع، تظل الحالة غير مكتملة
```

**القيود:** لا يمكن الادعاء بإعادة بناء Protected Store完全اً من Journal ما لم يحتوي Journal أو مصدر موثوق آخر على كل البيانات اللازمة. وجود مرجع في Journal لا يثبت وجود البيانات في Protected Store، ولا يمنح صلاحية استرجاع بيانات محذوفة.

---

#### النمط 5 (مقترح): نموذج هجين — Journal للقرارات، Protected Store للبيانات الوصفية، مع أحداث انتقال في Append-only Journal

**الوصف:** يُكتب أول سجل في Coordinator Journal يُثبت نية العملية وبياناتها الوصفية المرجعية (بدون المحتوى الحساس). ثم يُكتب في Protected Store. لا يُستخدم تحديث صامت لحالة من PENDING إلى COMMITTED. بدلاً من ذلك، تُضاف أحداث انتقال جديدة في Append-only Journal لكل تغيير حالة.

| المعيار | التقييم |
|--------|---------|
| Atomicity | ذرية في Journal فقط، Protected Store يُكتب بعد commit |
| Consistency | قوي للقرارات، eventual للبيانات الوصفية |
| سلوك التعطل بين الكتابات | إذا تعطل بعد Journal وقبل Protected Store: العملية معلقة، يُستأنف أو يُلغى حسب فencing |
| Idempotency | معرف evento يُستخدم لمنع الكتابة المكررة في Protected Store، الأحداث المتعارضة تُحل عبر التسلسل |
| الاستعادة | قراءة Journal، تحديد العمليات غير المكتملة، استئناف أو إلغاء عبر أحداث جديدة |
| توافق Append-only Journal | مباشر، لا تحديث صامت للحالات |
| توافق Privacy Gateway | Journal يحتوي على مراجع غير حساسة، البيانات في Protected Store مشفرة |
| توافق Cryptographic Erasure | إتلاف المفاتيح يجعل بيانات Protected Store غير قابلة للقراءة، Journal يحتفظ فقط بالمراجع |
| أثر على الحذف والنسخ الاحتياطية | نسخة احتياطية من Journal كافية، Protected Store يُعاد بناؤه أو يُترك مع المفاتيح المتلفة |
| التعقيد التشغيلي | متوسط |
| ما يمكن إثباته محلياً | Commit في Journal، كتابة في Protected Store |
| ما يعتمد على خدمة خارجية | لا شيء للاستئناف المحلي |

**تسلسل الكتابة والتعطل والاستعادة (باستخدام أحداث انتقال):**
```
تApplication: escribir en Journal seq=100 con estado=PENDING_PROTECTED_STORE
        ↓ (تعطل antes de escribir en Protected Store)
استعادة: leer Journal, encontrar seq=100 en estado=PENDING_PROTECTED_STORE
        → خيار أ: escribir en Protected Store, luego agregar evento seq=101 con estado=PROTECTED_STORE_WRITTEN
        → خيار ب: agregar evento seq=101 con estado=CANCELLED (إذا تم إلغاء العملية)
        → تكرار نفس seq=100 يُتجاهل idempotently إذا كان Protected Store يحتوي على البيانات بالفعل
        → إذا تعارضت حالة Journal مع حالة Protected Store، تُستخدم حالة Journal كمصدر الحقيقة وتُُعامل Protected Store كمحتاج لإعادة المزامنة
```

**القيود:** لا يوجد ضمان ذري بين المخازنين. هناك نافذة زمنية حيث Journal يؤكد العملية لكن Protected Store لم يكتب بعد. وجود مرجع في Journal لا يثبت وجود البيانات في Protected Store.

---

### أ.3 جدول المقارنة المصحح

| المعيار | النمط 1 | النمط 2 | النمط 3 | النمط 4 | النمط 5 (مقترح) |
|--------|---------|---------|---------|---------|-----------------|
| Atomicity بين المخازنين | نعم (نفس قاعدة البيانات) | لا | لا | نعم (في Journal فقط) | لا |
| احتمال فقدان بيانات Protected Store عند التعطل | منخفض | متوسط | مرتفع | عالٍ إذا كانت البيانات غير متاحة في Journal | متوسط |
| التعقيد التشغيلي | منخفض | متوسط | مرتفع | منخفض | متوسط |
| التوافق مع Append-only Journal | عالي | عالي | عالي | عالي | عالي |
| التوافق مع Cryptographic Erasure | متوسط | متوسط | منخفض | عالي | عالي |
| حماية البيانات الوصفية في Journal | منخفضة | متوسطة | متوسطة | عالية | عالية |
| Idempotency | عالية | عالية | عالية | عالية | عالية |
| إمكانية إعادة بناء Protected Store من Journal | غير متاح | غير متاح | غير متاح | فقط إذا كانت البيانات موجودة في Journal | فقط إذا كانت البيانات موجودة في Journal |

---

### أ.4 التوصية الهندسية

**الخيار المفضل:** النمط 5 (النموذج الهجين) مع عناصر من النمط 2 (Outbox) إذا لزم النقل غير المتزامن.

**تبرير:**
1. يحافظ على Coordinator Journal كمصدر الحقيقة الوحيد، وهو مبدأ أساسي في Jarvis.
2. لا يفترض معاملات ذرية بين مخازن منفصلة (غير مثبتة تقنياً).
3. يسمح باستئناف كتابة Protected Store من سجلات Journal عند التعطل.
4. يحمي البيانات الحساسة في Protected Store بالتشفير، مع بقاء Journal يحتوي فقط على مراجع غير حساسة.
5. يدعم fail-closed: إذا لم يمكن إثبات كتابة Protected Store، تُلغى العملية أو تُmarker كمعلقة.

---

### أ.5 الضمانات التي لا يمكن تحقيقها فعلياً

1. **لا ضمان ذري بين Coordinator Journal وProtected Store** إذا كانا في مخازن فيزيائية منفصلة.
2. **لا ضمان أن كتابة في Journal تعني كتابة ناجحة في Protected Store.**
3. **لا ضمان أن التعويض (compensation) يعادل التراجع الذري (rollback).**
4. **لا ضمان أن Protected Store يمكن إعادة بناؤه完全اً من Journal** إذا كانت الأحداث لا تحتوي على جميع البيانات اللازمة.
6. **لا ضمان ضد فقدان البيانات في Protected Store بسبب تعطل أثناء الكتابة** دون آلية استئناف مُطبقة ومختبرة.
7. **وجود مرجع في Journal لا يثبت وجود البيانات في Protected Store.**
8. **لا يمكن استرجاع بيانات محذوفة أو مفاتيح تالفة من خلال أي نمط.**

---

### أ.6 القرارات التي تحتاج موافقة المالك

1. **اختيار النمط:** أي من الأنماط الخمسة يُ adopted كأساس للتصميم.
2. **حدود المخازن:** هل يُوضع Protected Store في نفس قاعدة بيانات Coordinator Journal أم في مخزن منفصل.
3. **آلية الاستئناف:** كيف تُحدد العمليات غير المكتملة في Protected Store عند إعادة التشغيل.
4. **سياسة الإلغاء:** متى تُلغى عملية Pendng في Protected Store بعد تعطل النظام.

---

### أ.7 قائمة اختبارات الإثبات المطلوبة مستقبلاً

1. اختبار تعطل بعد commit في Journal وقبل كتابة Protected Store.
2. اختبار استعادة Protected Store من أحداث Journal (إذا كانت البيانات متاحة).
3. اختبار Idempotency للكتابة المكررة في Protected Store باستخدام نفس معرف الحدث.
4. اختبار Fail-closed: عدم اتخاذ قرارات بناءً على بيانات في Protected Store لم يُثبت كتابتها.
5. اختبار Cryptographic Erasure: إتلاف المفاتيح يجعل بيانات Protected Store غير قابلة للقراءة.
6. اختبار نسخ احتياطية: استعادة Journal وإعادة بناء Protected Store (إذا أمكن).
7. اختبار Concurrent writes: عمليات متزامنة على نفس الحدث في Journal وProtected Store.
8. اختبار تعطل قبل وبعد كل commit في كل مخزن.
9. اختبار انتهاء Lease أو تغير Fencing Token أثناء عملية الاستعادة.
10. اختبار حذف البيانات أثناء وجود عملية معلقة في Protected Store.
11. اختبار فقدان مفتاح التشفير وعدم قدرة النظام على استرجاع البيانات المقابلة.
12. اختبار وجود مرجع في Journal دون وجود البيانات المقابلة في Protected Store.
13. اختبار تعارض حالة Journal مع حالة Protected Store.

---

### أ.6 الملخص التنفيذي للدراسة

لا يوجد نمط يحقق الذرية الكاملة بين Coordinator Journal وProtected Store إذا كانا مخازنين فيزيائيين منفصلين. النمط 5 يوفر أفضل توازن بين الأمان والبساطة، مع acknowledgment صريح أن Protected Store يُعتبر derived data يُعاد بناؤه أو يُستأنف من Journal عند الحاجة **فقط إذا كانت البيانات متاحة**. أي اعتماد على هذا النمط يتطلب إثباتاً تقنياً لآلية الاستئناف وإعادة البناء قبل التنفيذ.

---

### أ.9 — Protected Store Operation Lifecycle and Recovery State Machine

#### أ.9.1 غرض الدراسة

تصميم دورة حياة واضحة للعملية بين تسجيل النية في Coordinator Journal وإثبات كتابة البيانات في Protected Store، مع معالجة جميع حالات الفشل والتعطل دون فرض إعادة محاولة تلقائية عند غموض النتيجة. هذه الدراسة غير معتمدة للتنفيذ.

#### أ.9.2 حالات الدورة الحياتية (Lifecycle States)

| الحالة | المعنى | نوع الحالة |
|--------|--------|------------|
| `PENDING_INTENT` | تم تسجيل نية العملية في Journal، لم تُكتب البيانات بعد في Protected Store | أساسية |
| `DATA_WRITTEN` | تم كتابة البيانات في Protected Store، لم يتم التحقق بعد | أساسية |
| `VERIFIED` | تم التحقق من وجود البيانات وسلامتها في Protected Store | أساسية |
| `COMPLETED` | اكتملت العملية بنجاح، البيانات متاحة للاستخدام | أساسية (نهائية) |
| `CANCELLED` | تم إلغاء العملية، لا تُستخدم البيانات | نهائية بديلة |
| `OUTCOME_UNKNOWN` | نتيجة العملية غير معروفة، لا تُستخدم البيانات | نهائية بديلة |

**ملخص الحالات:** 4 حالات أساسية (PENDING_INTENT, DATA_WRITTEN, VERIFIED, COMPLETED) + 2 حالات نهائية بديلة (CANCELLED, OUTCOME_UNKNOWN) = 6 حالات إجمالية.

#### أ.9.3 الأحداث في Append-only Journal (لا تعديل للأحداث السابقة)

| الحدث | المعنى |
|-------|--------|
| `INTENT_REGISTERED` | تسجيل نية العملية في Journal |
| `DATA_WRITE_INITIATED` | بدء كتابة البيانات في Protected Store |
| `DATA_WRITE_COMPLETED` | إتمام كتابة البيانات في Protected Store |
| `VERIFICATION_PASSED` | التحقق من وجود البيانات وسلامتها |
| `OPERATION_CANCELLED` | إلغاء العملية |
| `OUTCOME_UNKNOWN_RECORDED` | تسجيل نتيجة غير معروفة |

#### أ.9.4 آلة الحالات (State Machine) وجدول الانتقالات

```
حالة البداية: لا توجد حالة (العملية غير موجودة)

INTENT_REGISTERED
    ↓ (كتابة البيانات تبدأ)
DATA_WRITE_INITIATED
    ↓ (كتابة البيانات تمت)
DATA_WRITE_COMPLETED
    ↓ (التحقق نجح)
VERIFIED
    ↓ (العملية اكتملت)
COMPLETED
    ↓ (إلغاء في أي مرحلة قبل COMPLETED)
CANCELLED
    ↓ (النتيجة غير معروفة في أي مرحلة قبل COMPLETED)
OUTCOME_UNKNOWN
```

| الحالة الحالية | الحدث | الحالة التالية | شرط الانتقال | prohibition |
|---------------|-------|---------------|-------------|-------------|
| (غير موجودة) | `INTENT_REGISTERED` | `PENDING_INTENT` | موافقة Coordinator، لا يوجد Delete Barrier نشط | إذا كان Delete Barrier نشطاً، يُرفض التسجيل |
| `PENDING_INTENT` | `DATA_WRITE_INITIATED` | `DATA_WRITE_INITIATED` | بدء الكتابة في Protected Store | لا يُعتبر كتابةUCCESS حتى التحقق |
| `DATA_WRITE_INITIATED` | `DATA_WRITE_COMPLETED` | `DATA_WRITE_COMPLETED` | اكتمال الكتابة محلياً | لا يُعتبر ناجحاً حتى التحقق |
| `DATA_WRITE_COMPLETED` | `VERIFICATION_PASSED` | `VERIFIED` | التحقق من وجود وسلامة البيانات | إذا فشل التحقق، تعود إلى OUTCOME_UNKNOWN |
| `VERIFIED` | (إكمال تلقائي) | `COMPLETED` | جميع الشروط محققة | لا يُستخدم حتى completes |
| أي حالة قبل `COMPLETED` | `OPERATION_CANCELLED` | `CANCELLED` | إلغاء من Coordinator أو Delete Barrier | لا تُستخدم البيانات بعد الإلغاء |
| أي حالة قبل `COMPLETED` | `OUTCOME_UNKNOWN_RECORDED` | `OUTCOME_UNKNOWN` | عدم إمكانية تحديد النتيجة | لا إعادة محاولة تلقائية |
| `COMPLETED` | (لا انتقالات) | `COMPLETED` | الحالة نهائية | لا تعديل |

#### أ.9.5 معالجة حالات الفشل

| حالة الفشل | الإجراء المطلوب | السبب |
|------------|----------------|-------|
| تعطل بعد `INTENT_REGISTERED` قبل كتابة البيانات | تبقى الحالة `PENDING_INTENT`، عند الاستعادة يُستأنف الإجراء أو يُلغى | لا تُفترض كتابة لم تُثبت |
| تعطل بعد `DATA_WRITE_INITIATED` قبل `DATA_WRITE_COMPLETED` | الحالة غير مؤكدة، يُحقق من وجود البيانات في Protected Store | لا تُفترض نجاح أو فشل |
| تعطل بعد `DATA_WRITE_COMPLETED` قبل `VERIFICATION_PASSED` | تُجرى عملية تحقق من وجود البيانات وسلامتها | التحقق مطلوب قبل الاستخدام |
| تكرار تنفيذ العملية بنفس معرف الحدث | تُتجاهل العملية المكررة idempotently | منع التكرار |
| انتهاء Lease أو تغير Fencing Token أثناء العملية | تُوقف العملية، تُmarker كـ `OUTCOME_UNKNOWN` أو `CANCELLED` | منع عملية قديمة من الاستكمال |
| حذف البيانات أثناء عملية معلقة | تُmarker العملية كـ `CANCELLED` أو `OUTCOME_UNKNOWN` | لا تُستخدم بيانات محذوفة |
| فقدان مفتاح التشفير | البيانات في Protected Store تصبح غير قابلة للقراءة، تُmarker كـ `OUTCOME_UNKNOWN` | لا يمكن استرجاع البيانات بدون المفتاح |
| وجود مرجع في Journal دون بيانات مقابلة | تُmarker كـ `OUTCOME_UNKNOWN` | المرجع لا يثبت وجود البيانات |
| وجود بيانات في Protected Store دون حدث موثوق في Journal | تُرفض البيانات، لا تُستخدم | لا يوجد مصدر حقيقة موثق |
| تعارض حالة Journal مع حالة Protected Store | تُستخدم حالة Journal كمصدر الحقيقة، تُmarker Protected Store كمحتاجة لإعادة المزامنة | Journal هو مصدر الحقيقة الوحيد |

#### أ.9.6 شروط السماح باستخدام بيانات Protected Store

يُسمح باستخدام البيانات فقط عندما تتحقق جميع الشروط التالية:

1. الحالة في Journal هي `COMPLETED` (أو `VERIFIED` مع حدث إكمال موثق)
2. تم التحقق من وجود البيانات وسلامتها في Protected Store (`VERIFICATION_PASSED`)
   - الدليل المطلوب: حدث `VERIFICATION_PASSED` في Journal يثبت أن عملية التحقق من وجود البيانات وسلامتها قد اكتملت بنجاح
   - `DATA_WRITE_COMPLETED` وحده لا يُعتبر دليلاً كافياً على سلامة البيانات؛ فهو يُثبت فقط أن كتابة البيانات اكتملت محلياً، لا أن البيانات سليمة أو قابلة للقراءة
   - تأكيد Adapter (إن وجد) لا يُعتبر بديلاً عن التحقق من البيانات في Protected Store؛ كلاهما أدلة مستقلة ولا يُستبدل أحدهما بالآخر
3. لا يوجد Delete Barrier نشط على النطاق
4. Fencing Token الحالي ساري وليس منتهي
5. مفتاح التشفير متاح ولم يُتلف
6. لم يتم إلغاء العملية (`CANCELLED` أو `OUTCOME_UNKNOWN`)

يُمنع الاستخدام (Fail Closed) عندما:
- أي شرط من الشروط أعلاه غير محقق
- الحالة في Journal هي `PENDING_INTENT`، `DATA_WRITE_INITIATED`، `DATA_WRITE_COMPLETED` دون `VERIFICATION_PASSED`
- الحالة هي `CANCELLED` أو `OUTCOME_UNKNOWN`
- يوجد تعارض بين حالة Journal وحالة Protected Store

#### أ.9.7 استئناف مقابل إلغاء مقابل نتيجة غير معروفة

| الإجراء | متى يُستخدم | الشروط |
|--------|------------|--------|
| استئناف (Resume) | بعد تعطل، إذا كانت النية مسجلة والبيانات قابلة للكتابة | لا يوجد Delete Barrier، Fencing Token ساري |
| إلغاء (Cancel) | عندما لا يمكن إكمال العملية بشكل آمن | يُسجل حدث `OPERATION_CANCELLED` في Journal |
| نتيجة غير معروفة (Unknown Outcome) | عندما لا يمكن تحديد النجاح أو الفشل | يُسجل حدث `OUTCOME_UNKNOWN_RECORDED`، لا إعادة محاولة تلقائية |

**قاعدة هامة:** لا يُنفذ Retry تلقائياً عندما تكون النتيجة غير معروفة. أي محاولة جديدة تتطلب معاملة جديدة من Coordinator بعد التحقق من الحواجز.

#### أ.9.8 مصدر البيانات اللازمة لإعادة البناء

- لا يُفترض أن Journal يحتوي على المحتوى الأصلي للبيانات
- Journal يحتوي على مراجع ومعرفات घटनات فقط
- إذا لزم إعادة بناء البيانات، يجب أن يكون هناك مصدر موثوق منفصل bevat البيانات الأصلية
- إذا فقد مصدر البيانات الأصلي أو تضررت مفاتيح التشفير، لا يمكن إعادة البناء
- وجود مرجع في Journal لا يثبت وجود البيانات في Protected Store

#### أ.9.9 منع العمليات القديمة من استكمال الكتابة

1. كل عملية مرتبطة بـ Fencing Token وLease.
2. قبل أي كتابة إلى Protected Store، يتم التحقق من سارية Fencing Token الحالي.
3. عند انتهاء Lease أو تغير Fencing Token، تُرفض أي محاولة لاستكمال العملية القديمة.
4. يُسجل حدث إلغاء في Journal عند انتهاء الصلاحية.
5. العمليات ذات Fencing Token قديم تُرفض حتى لو كانت بيانات مكتوبة جزئياً.

**تحذير تقني:**由於 تقنية التخزين غير محددة، لا يمكن إثبات أن فحص فencing يحدث "بشكل ذري" مع عملية الكتابة الفعلية. قد يحدث سباق بين فحص صلاحية Token وتنفيذ الكتابة في Protected Store. لا يمكن الادعاء بأن هذا السباق معدوم دون آلية تقنية محددة ومختبرة. هذا الضمان غير قابل للإثبات حالياً.

#### أ.9.10 الضمانات التي يمكن إثباتها والحدود التي لا يمكن ضمانها

**يمكن إثباتها:**
- أن حدث `INTENT_REGISTERED` موجود في Journal قبل أي كتابة إلى Protected Store
- أن كل كتابة إلى Protected Store مرتبطة بمعرف حدث فريد في Journal
- أن حالة `COMPLETED` تتطلب حدث `VERIFICATION_PASSED` سابق
- أن عملية الإلغاء تسجل حدث `OPERATION_CANCELLED` في Journal
- أن لا إعادة محاولة تلقائية عند `OUTCOME_UNKNOWN`

**لا يمكن ضمانها:**
- أن كتابة في Journal تعني كتابة ناجحة في Protected Store
- أن البيانات في Protected Store يمكن استرجاعها بعد فقدان مفتاح التشفير
- أن البيانات المحذوفة يمكن استرجاعها من أي مصدر
- أن Protected Store يمكن إعادة بناؤه完全اً من Journal إذا كانت البيانات غير موجودة في مصدر موثوق
- أن لا توجد فجوة زمنية بين كتابة Journal وكتابة Protected Store
- أن عملية الإلغاء (`CANCELLED`) تثبت عدم حدوث كتابة جزئية للبيانات في Protected Store

**تمييز بين الإلغاء والبيانات يتيمة والتنظيف:**
- **إلغاء العملية:** يُسجل حدث `OPERATION_CANCELLED` في Journal، ويمنع استخدام البيانات، لكنه لا يثبت عدم حدوث كتابة جزئية في Protected Store قبل الإلغاء.
- **اكتشاف بيانات يتيمة:** وجود بيانات في Protected Store دون حدث موثوق مقابل في Journal؛ تُرفض البيانات ولا تُستخدم.
- **تنظيف البيانات:** حذف البيانات من Protected Store يحتاج قراراً من مالك المشروع وسياسة حذف محددة، غير محددة في هذا المستند.

#### أ.9.11 اختبارات الإثبات المطلوبة مستقبلاً

1. اختبار تسجيل النية في Journal قبل أي كتابة إلى Protected Store
2. اختبار تعطل بعد `INTENT_REGISTERED` قبل كتابة البيانات
3. اختبار تعطل بعد `DATA_WRITE_INITIATED` قبل `DATA_WRITE_COMPLETED`
4. اختبار تعطل بعد `DATA_WRITE_COMPLETED` قبل `VERIFICATION_PASSED`
5. اختبار تكرار تنفيذ العملية بنفس معرف الحدث (idempotency)
6. اختبار انتهاء Lease أثناء عملية معلقة
7. اختبار تغير Fencing Token أثناء عملية معلقة
8. اختبار سباق بين فحص Fencing Token وتنفيذ الكتابة في Protected Store
9. اختبار حذف البيانات أثناء عملية معلقة
10. اختبار فقدان مفتاح التشفير وعدم القدرة على استرجاع البيانات
11. اختبار وجود مرجع في Journal دون بيانات مقابلة في Protected Store
12. اختبار وجود بيانات في Protected Store دون حدث موثوق في Journal
13. اختبار تعارض حالة Journal مع حالة Protected Store
14. اختبار Write بواسطة عامل قديم (Stale Worker) بعد انتهاء Fencing Token
15. اختبار إلغاء العملية (`OPERATION_CANCELLED`) بعد كتابة جزئية في Protected Store
16. اختبار Fail Closed: منع استخدام البيانات عندما لا تتحقق جميع شروط الاستخدام
17. اختبار عدم وجود إعادة محاولة تلقائية عند `OUTCOME_UNKNOWN`
18. اختبار استئناف العملية بعد تعطل مع Fencing Token ساري
19. اختبار إلغاء العملية عبر حدث `OPERATION_CANCELLED` في Journal

#### أ.9.12 القرارات التي تحتاج موافقة المالك

1. **آلية التحقق من وجود البيانات:** كيف يتم التحقق من وجود وسلامة البيانات في Protected Store بعد الكتابة
2. **مصدر بيانات إعادة البناء:** ما هو المصدر الموثوق الذي يحتوي على البيانات الأصلية إذا لزم إعادة البناء
3. **سياسة الإلغاء التلقائي:** متى يُلغى النظام عملية معلقة تلقائياً مقابل انتظار intervention يدوي
4. **مهلة الاستئناف:** المدة القصوى التي يمكن أن تبقى فيها العملية في حالة `PENDING_INTENT` قبل الإلغاء الإجباري
5. **إجراءات التعامل مع فقد المفتاح:** ماذا يُفعل عندما يُفقد مفتاح التشفير لبيانات في Protected Store

#### أ.9.13 سجل إغلاق التصنيف التوثيقي — Protected Store

**تاريخ الإغلاق:** 2026-11-03
**نطاق الإغلاق:** مراجعة تصنيف متطلبات الإثبات الأمني لـ Protected Store في الملحق أ.9 (الأسطر 540–729).
**نوع الإغلاق:** إغلاق توثيقي فقط.

**1. حالة مراجعة التصنيف**
مراجعة التصنيف التوثيقية أُغلقت توثيقياً فقط.
هذا يعني أن كل عنصر في أ.9 المرتبط بحماية البيانات أثناء الكتابة الجارية والمتأخرة والإلغاء قد تم تصنيفه إلى إحدى الفئات التالية:
- متطلب أمني موثق بنص صريح
- حاجة أمنية مستنتجة
- دليل تقني مطلوب
- معلومات معمارية ناقصة
- قرار ملكي صريح

إغلاق التصنيف لا يعني اعتماد أ.9، ولا اكتمال الجاهزية التقنية أو الأمنية، ولا السماح بالتنفيذ.

**2. الأدلة التقنية المفتوحة (TE-01 إلى TE-08)**

| المعرف | الدليل المطلوب | الحالة | الأساس النصي |
|--------|---------------|--------|-------------|
| TE-01 | إثبات ذرية فحص Fencing Token مع الكتابة الفعلية | مفتوح | أ.9.9، السطر 662 |
| TE-02 | إثبات قدرة تقنية التخزين المختارة على الرفض الشرطي للكتابة | مفتوح | السطر 662 + الأسطر 720–721 |
| TE-03 | آلية رصد الكتابة المتأخرة بعد الإلغاء | مفتوح | غير موجود في أ.9 |
| TE-04 | دليل تقني للتعامل مع البيانات الجزئية بعد CANCELLED | مفتوح | أ.9.10، السطر 682 |
| TE-05 | آلية حماية مسارات الاستعادة (backups, caches, replicas) | مفتوح | لا يوجد نص في أ.9 |
| TE-06 | إثبات منع الاستخدام رغم وجود البيانات مادياً | مفتوح | الأسطر 679، 682 |
| TE-07 | آلية كشف البيانات اليتيمة (بدون حدث Journal موثق) | مفتوح | السطر 613 |
| TE-08 | إثبات علاقة Fencing Token في أ.9.9 بـ D-03 | مفتوح | د-03، الأسطر 45–54 مقابل أ.9.9، الأسطر 656–662 |

**تحفظ:** TE-02 ما زال دليلاً تقنياً مطلوباً، ولا توجد تقنية تخزين محددة تثبت القدرة على الرفض الشرطي.

**3. المعلومات المعمارية الناقصة المفتوحة (MI-01 وMI-02)**

| المعرف | المعلومة | الحالة | الأساس النصي |
|--------|--------|--------|-------------|
| MI-01 | تقنية التخزين المختارة لـ Protected Store | مفتوحة | الأسطر 720–721 |
| MI-02 | معنى Delete Barrier (آلية واحدة أم استخدامات متعددة) | مفتوحة | الأسطر 592، 597، 625، 640 |

**4. قرارات المالك المطلوبة (OD-03)**

| المعرف | القرار | الحالة | النص الداعم | النطاق | لا يشمل |
|--------|--------|--------|------------|-------|---------|
| OD-03 | سياسة الحذف المادي من Protected Store | مطلوب، لم يُتخذ بعد | أ.9.10، السطر 684 | سياسة الحذف المادي فقط | آلية التنفيذ، مصير البيانات الجزئية، أي إجراء تقني محدد |

**تحفظ:** OD-03 لا يغطي تلقائياً جميع أشكال معالجة البيانات الجزئية بعد CANCELLED.

**5. ملخص الفجوات المتبقية**

| الفئة | العدد | العناصر |
|-------|-------|---------|
| أدلة تقنية مطلوبة (مفتوحة) | 8 | TE-01، TE-02، TE-03، TE-04، TE-05، TE-06، TE-07، TE-08 |
| معلومات معمارية ناقصة (مفتوحة) | 2 | MI-01، MI-02 |
| قرارات ملكية مطلوبة (لم تُتخذ) | 1 | OD-03 |

**6. توضيح مهم**
اكتملت مراجعة التصنيف وفق النصوص والأدلة المتاحة، مع إبقاء الفجوات غير المحسومة مفتوحة.

**علاقة بالقسم «النقاط التي بقيت غير محسومة»:**
يظل قسم `### النقاط التي بقيت غير محسومة` سارياً ومستقلاً. سجل الإغلاق أعلاه لا يحل محل ذلكsection، ولا يغلق الفجوات الواردة فيه. MI-01 وMI-02 والفجوات الأخرى المذكورة في ذلكsection remain مفتوحة.

---

### النقاط التي بقيت غير محسومة

- العلاقة الفيزيائية بين Protected Store وCoordinator Journal (نفس قاعدة البيانات أم منفصلة).
- تقنية التخزين الفعلية لكل مخزن.
- آلية الاستئناف المحددة للكتابة إلى Protected Store بعد التعطل.
- سياسة الإلغاء للعمليات المعلقة.
- ما إذا كان Journal سيحتوي على جميع البيانات اللازمة لإعادة بناء Protected Store أم केवल مراجع.
- إجراءات التعامل مع حالات التعارض بين حالة Journal وحالة Protected Store.

---

---
