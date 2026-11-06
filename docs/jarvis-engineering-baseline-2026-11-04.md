# Jarvis Engineering Baseline — 2026-11-04

## 1. Baseline Metadata

| Field | Value |
|-------|-------|
| Date | 4 نوفمبر 2026 |
| Branch | master |
| Repository | local project directory |
| Baseline type | Engineering verification (build + tests) |
| Authorized by | User instruction (this session) |
| VS Code task modification | Approved (this session only) |
| Jarvis architecture / D-01 to D-13 / A.9 implementation | Not approved |
| Security guarantees verified | No (see Section 5) |

## 2. Verified Build and Test Results

| Check | Command | Result |
|-------|---------|--------|
| Build | `npm.cmd run build` | Success |
| Tests | `npm.cmd test` | Success |
| Test count | `npm.cmd test` | 77 passed, 0 failed, 0 skipped, 0 cancelled |
| Duration | `npm.cmd test` | 2954.2038 ms |

### 2.1 Updated Tests in `tests/tasks.test.ts`

Both updated tests passed:

| Test name | Result | Duration | Scope |
|-----------|--------|----------|-------|
| OpenRouter live task uses hidden local key input and runs only the free-router test | Passed | 5.8497 ms | Mocked configuration test — no live OpenRouter connection executed; does not prove live free-model usage |
| Jarvis chat task passes the hidden key only to the project-local chat process | Passed | 1.4117 ms | Mocked configuration test — verifies task setup only; does not prove VS Code task runner execution |

## 3. VS Code Task Approval

The following four tasks were **configured** in `.vscode/tasks.json` using `"type": "process"` with `"command": "cmd.exe"`:

1. `Jarvis: Build` — `npm.cmd run build`
2. `Jarvis: Test` — `npm.cmd test`
3. `Jarvis: Start Chat` — `npm.cmd run chat` (with `OPENROUTER_API_KEY` from `${input:openrouterApiKey}`)
4. `Jarvis: OpenRouter Check (Free)` — `npm.cmd run openrouter:live-test` (with `OPENROUTER_API_KEY` from `${input:openrouterApiKey}`)

**Scope note:** The tests in `tests/tasks.test.ts` verified the task configuration (labels, types, commands, args, env) only. They did **not** execute the tasks through the VS Code task runner and do not prove runtime execution of these tasks.

## 4. Modified Files

| File | Change |
|------|--------|
| `.vscode/tasks.json` | Reduced from 12 tasks to 4 approved tasks; changed `"type": "shell"` to `"type": "process"`; removed `options.shell` wrapper; consolidated env handling |
| `tests/tasks.test.ts` | Updated task labels, types, commands, and args to match new tasks.json configuration |

## 5. Verified vs Untested — Clear Distinction

### Verified (executed and passed)

- TypeScript compilation via `tsc -p tsconfig.json`
- All 77 unit tests in `dist/tests/*.test.js`
- Provider routing through OpenRouter free router (mocked)
- Privacy blocking patterns (mocked)
- Memory store persistence, revision history, and conflict detection **within test scope only** — does not prove encryption guarantees, secure deletion guarantees, or write-delay protection
- Task context bounds, deduplication, and sensitive-data filtering
- `tasks.test.ts` validation of VS Code task configuration

### Untested (security guarantees NOT verified by this baseline)

| Guarantee | Status | Reason |
|-----------|--------|--------|
| Gate fencing proof | Untested | No crash-injection or fencing tests executed |
| Witness contract proof | Untested | No Witness/anchor integration tests |
| Deletion inventory completeness | Untested | No storage census performed |
| Restore guard / non-restorability | Untested | No restore drills executed |
| Encryption / key management | Untested | No crypto profiles or destruction proofs |
| Projection transaction / consistency | Untested | No concurrency or isolation tests |
| External dependency / RPO contracts | Untested | No provider or Witness contracts reviewed |
| Historical source integrity | Untested | v1.0–v3.3 sources unavailable; v3.6 source damaged |

## 6. Files NOT Modified

- `docs/jarvis-v3.7-owner-decisions.md` — not modified (per restriction)
- Decisions D-01 through D-13 — not modified (per restriction)
- `package.json` — not modified
- Source code — not modified
- Database — not modified
- No commit performed

## 7. Git Status at Baseline Time

```
 M .vscode/tasks.json
 M tests/tasks.test.ts
?? .vscode/extensions.json
?? docs/
```

All changes are unstaged. No commit was created.

## 8. Next Steps (Not Authorized in This Session)

- Owner approval of unresolved decisions D-02 through D-13
- Technical verification of untested security guarantees listed in Section 5
- Recovery of authoritative v3.6 source if needed
- Implementation design after owner approvals
