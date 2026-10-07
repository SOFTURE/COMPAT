# Plan review: release-readiness

Reviewed: plan.md @ 2026-10-07. Mode: deep. Verdict: ready after fixes.
Findings: 1 critical, 1 warning, 0 suggestion.
Grounding: 14/14 paths, 9/9 symbols (`runCheck`, `parseConfig`, `LAYERS`, `openRefTree`, `createRepo`, `createIo`, `shouldSkipRealOasdiff`, `USAGE`, `RULE_CLASSES`), 3/3 commands (`workflow.json` gates)

## Lenses
| Lens | Result |
| --- | --- |
| Coverage and end state | FAIL (C1) |
| Slicing | PASS |
| Verifiability | PASS |
| Data and migrations | PASS (none) |
| Tests | PASS |
| Security | PASS (token only through `secrets.NPM_TOKEN`; publish job checks tag and branch) |
| Lean | PASS |
| Fit | PASS (`init` reuses `RefTree`, `parseConfig`, the `CheckIo` shape) |
| Cost and defaults | PASS |
| Scope | PASS |
| Reuse | PASS |
| Lessons | PASS (no numbered lessons) |
| Progress format | PASS |
| Detection rules | WARN (W1) |

## Findings

### C1 [CRITICAL] The acceptance gate expectation contradicts F2
**Effort:** low. **Lens:** Coverage and end state. **Where:** Phase 1, step 2 (plan.md) · `src/model/gate.ts:23`
**Problem:** the plan expected exit 0 at the default gate, but F2 is `breaking` and the default `--fail-on` is
`breaking`, so the run exits 1 (`test/e2e/openapi.test.ts:62` asserts exactly that). The test would encode a wrong
contract or fail.
**Fix:** expect exit 1 at the default gate with `openapi` as the only reason, then accept F2 (the PETSEO decision)
and expect exit 0 at the default gate and 1 at `--fail-on rollback-risk`.
**Decision:** Fix now (applied) - Phase 1 step 2, its Done-when bullet and Progress 1.1 rewritten.

### W1 [WARNING] Drizzle dialect value not pinned
**Effort:** low. **Lens:** Detection rules. **Where:** Phase 2, step 1 (plan.md)
**Problem:** "whose dialect is PostgreSQL" leaves the implementer guessing the journal value; drizzle-kit writes
`postgresql` today and `pg` in older journals.
**Fix:** name both accepted values.
**Decision:** Fix now (applied) - step 1 names `postgresql` and `pg`.

## Triage summary
Fixed: C1, W1. Accepted: -. Deferred: -. Dismissed: -. Verdict after triage: ready after fixes.

## Decisions (auto)
- C1 acceptance gate expectation → Fix now (clear local fix).
- W1 drizzle dialect → Fix now (clear local fix).
