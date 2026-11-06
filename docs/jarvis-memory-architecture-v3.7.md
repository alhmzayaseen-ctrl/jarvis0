# Jarvis Memory Architecture v3.7

Status: Architectural Final Consolidation — Not Approved for Implementation

Date: 2026-11-03
Corrects/consolidates: v3.4, v3.5, v3.6, v3.6.1, v3.6.2

## 1. Goal and Scope

This document is the consolidated architectural final for Jarvis memory. It resolves documentation-level inconsistencies across prior versions and provides a single coherent design surface for later implementation approval. It authorizes no implementation, test, simulation, database access, deletion, encryption, external service call, Phase A, or Phase B.

## 2. Version History and Sources

Reviewed sources: v3.4, v3.5, v3.6, v3.6.1, v3.6.2. v3.6 source corruption (malformed title and component row) remains recorded and unrepaired. v1.0–v3.3 original documents remain unavailable; no release attribution invented.

## 3. Core Architectural Principles

- Short-Term Memory, Long-Term Memory, Working Memory/Context Builder remain distinct.
- Knowledge Base is separate from personal memory.
- Retrieval is multi-dimensional, bounded, task-scoped, provenance-aware.
- Relationship Engine, Experience/Skills Memory, Sleep-time Consolidation preserved.
- Source, history, confidence, importance retained for every fact; contradictions preserved, not silently resolved.
- Privacy Gateway separates local vs cloud; sensitive data never leaves without authorization and consent.
- No fact/permission change without user consent.
- Coordinator Journal is sole source of truth for committed decisions, barriers, grants, revocations, fencing generations, commit order.
- Fail-closed on uncertainty.

## 4. Components and Responsibilities

Coordinator (sole ordering authority), Admission Projection (derived), Memory Content Store, Protected Link Store, Payload Binding Vault, Key Store, Local Backups, Temporary Context/Cache, Consolidation Worker, Retrieval Engine, Relationship Engine, Privacy Gateway, Egress Gate, Dispatch Gate, Result Delivery. Damaged v3.6 component row remains unresolved (BLOCKER-362-09).

## 5. Data Flow, Memory, Retrieval

1. Ingest → Working Memory → classification by source/confidence/importance.
2. Retrieval decision order: deletion tombstones → visibility gate → permissions → namespace → task scope → temporal eligibility (TIME_VALID/INVALID/NOT_APPLICABLE/REQUIRED_BUT_UNKNOWN/BOUNDARY_OPEN) → sensitivity policy by execution location → ranking by relevance/provenance/confidence/importance/relationships → abstain/insufficiency if inadequate.
3. Local authorized use may include sensitive records; external egress requires separate approved policy and payload-bound authorization.
4. Bounded context, no full-memory dumps.

## 6. Security and Privacy

Consolidation metadata (ranges, hashes, digests, job IDs) is sensitive/linkable; protected store with least privilege; retention UNRESOLVED. Deletion inventory records sensitive even without payload; minimized fields; access audited; retention UNRESOLVED. No personal content or derived fingerprints in public journal/Witness/audit. Encryption/key management and proof of destruction UNRESOLVED.

## 7. Deletion and Non-Restorability

Complete inventory relative to approved scope/discovery sources; unknown locations block completion. Separate states: LOCAL_CLEANUP_EXECUTED, LOCAL_RESTORE_GUARD_VERIFIED, LOCAL_NON_RESTORABILITY_VERIFIED, LOCAL_DELETION_COMPLETED. External effects separate. No absolute irrecoverability claim without technical basis.

## 8. External Send and Result Management

Four stages: Adapter entry, network initiation, remote receipt, external acceptance/effect. Evidence never promoted across stages. `SEND_STARTED` ≠ dispatch. `DISPATCH_CLAIMED` ≠ adapter entry. `DISPATCH_BOUNDARY_UNKNOWN` on uncertain crash. No automatic retry on unknown outcome. Result Delivery same rules. Lease/fencing prevents stale workers. RPO/contracts UNRESOLVED.

## 9. Journal, Projection, Consistency

Journal sole authority; projection derived, non-authoritative. Watermark = highest applied event/order + source revision. Projection usable only with verified current head, no omitted barriers, Coordinator commit against expected revision/fence. Stale/missing/corrupt/ahead/crash behaviors fail-closed; RECOVERY_REQUIRED on contradiction. No atomicity claim without storage proof.

## 10. Consolidation

Resumable, proposal/review based, no auto-write of confirmed memories. Protected metadata store; access roles proposed; retention/terminal states UNRESOLVED. Checkpoint inconsistency → recompute from authorized events or stop for review. Deletion stops scope processing; inventory includes ranges/checkpoints/digests.

## 11. Failure and Recovery

Crash at any send stage handled per evidence matrix. Concurrent operations serialized per scope. Backup restore applies tombstones/key floors. Permission changes mid-operation invalidate grants. Deletion during read/derivation blocks via barrier. Failover preserves journal authority.

## 12. BLOCKER-362 Resolution Table

| # | Issue | Why blocker | Proposed resolution | Required evidence | Test | Owner | Status |
|---|---|---|---|---|---|---|---|
| 01 | Classification semantics | Inconsistent usage | Adopt dictionary in v3.6.2 §1.1; add CORRECTED | Project-wide agreement | Doc review | Architect | PROPOSED |
| 02 | Consolidation privacy | Store/access/retention unapproved | Protected store + least privilege | Crypto/access review | Security review | Owner | PROPOSED |
| 03 | Pre-claim stop | Gate fencing unproven | Fence + no-claim proof else uncertainty | Gate contract proof | Fault injection (future) | Engineer | UNRESOLVED |
| 04 | Adapter/network evidence | No instrumentation/contracts | Define stage events + receipt contracts | Trusted instrumentation | Integration (future) | Engineer | UNRESOLVED |
| 05 | Deletion inventory | No census | Approved scope/discovery sources | Storage census | Audit (future) | Owner | PROPOSED |
| 06 | Restore guard | No proof | Evidence list §4.3 | Restore path proof | Recovery test (future) | Engineer | UNRESOLVED |
| 07 | Inventory retention/privacy | No roles/retention | Least privilege + owner decision | Access policy | Security review | Owner | UNRESOLVED |
| 08 | Projection consistency | No transaction proof | Fail-closed + consistent read | Storage isolation proof | Concurrency test (future) | Engineer | UNRESOLVED |
| 09 | Source integrity | Damaged v3.6 | Recover clean source if needed | Authoritative artifact | Source audit | Owner | UNRESOLVED |
| 10 | External deps/RPO | No contracts | Define Witness/anchor/provider/RPO | Contracts | DR test (future) | Owner | UNRESOLVED |
| 11 | Historical provenance | No originals | Mark UNRESOLVED | Original docs | Provenance review | Owner | UNRESOLVED |

No blocker considered RESOLVED; all require approval/evidence.

## 13. Architectural Decision Register

Preserved: journal authority, no success from STARTED, fail-closed, witness-first deletion, metadata privacy risk, bitemporal semantics, separate send/delivery, bounded retrieval, consolidation resumability. Modified: sensitivity exclusion, temporal taxonomy, watermark semantics. Corrected: pre-claim classification, inventory completeness gate, projection consistency. Proposed: protected stores, stage vocabulary, inventory format. Unresolved: crypto, retention, storage tech, fence proof, instrumentation, RPO, provenance.

## 14. Assumptions and Risks

Assumes single Coordinator authority; no distributed txn; no perfect erasure; damaged source unrecoverable by inference. Risks: unknown stores, stale fences, projection drift, retention gaps, privacy leakage via metadata.

## 15. Acceptance Criteria (Future)

- All blockers either owner-approved or explicitly scoped out.
- Fail-closed paths documented and testable.
- No unproven guarantees claimed.
- Source integrity either recovered or decisions scoped to intact text.

## 16. Owner Decisions Required

Retention periods, crypto profiles, storage tech, RPO/RTO, Witness/anchor contracts, access roles, terminal states, historical source recovery.

## 17. Final Readiness Assessment

Design is coherent at documentation level but not implementation-ready. All 11 blockers remain open (PROPOSED/UNRESOLVED), requiring owner decisions and technical proofs. Next logical step: owner approval of unresolved decisions and recovery of authoritative v3.6 source if needed, then implementation design/spec. No tests or technical verification performed.
