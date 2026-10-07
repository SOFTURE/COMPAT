# Implementation review: release-readiness

Scope: full · Date: 2026-10-07 · Commits: 6de5d4c..205470b · Gates: typecheck ✓ lint ✓ test ✓ (514 tests, real oasdiff required) · pack ✓ (4 tests) · actionlint ✓

## Verdict
Ready after fixes. The acceptance run reproduces F1, F2, F4, F5, F6, F7 and F10 in one check over all five layers,
`init` writes configs that `check` accepts, and the publish workflow refuses a tag that does not match the version or
is not on `master`. One real defect was fixed (`init` and `check` disagreed on the default config path when started
from a subdirectory); the rest are accepted suggestions.

## Dimensions
| Dimension | Verdict | Findings |
| --- | --- | --- |
| Plan coverage | PASS | - |
| Progress honesty | PASS | - |
| Correctness | PASS after fix | F1 |
| Tests | PASS | - |
| Security | PASS | - |
| Patterns | PASS | S1, S2 |

## Plan coverage
| Phase | Commit | Delivered | Notes |
| --- | --- | --- | --- |
| 1 Acceptance run | 6de5d4c | yes | config uses the ansible regex source but not the .NET one; F10 asserted on the compose keys the research names |
| 2 `init` | 53011bb | yes | |
| 3 Package, CI, publish | 8839dc6 | yes | README assertion moved to phase 4 (recorded in Decisions (auto)) |
| 4 README | 38c7cad | yes | |
Files: planned and changed 14 · unplanned 0 · planned, not changed 0

## Findings

### F1 [WARNING] `init` and `check` used different default config paths
**Impact:** LOW (obvious, narrow fix) · **Dimension:** Correctness · **Where:** `src/commands/init.ts` (runInit)
**What:** `init` wrote `<git root>/compat.config.json`, while `check` reads `<--repo or cwd>/compat.config.json`
(`src/commands/check.ts:169`). **Why it matters:** run from a subdirectory, `init` succeeds and the next `check` says
"config file not found". **Evidence:** the new test "writes where check reads by default when started from a
subdirectory" fails without the fix and passes with it.
**Fix:** use the same default as `check`; README wording aligned.
**Decision:** fix now: default path is `<repoDir>/compat.config.json` (205470b)

### S1 [SUGGESTION] `init` may detect files under test fixture folders
**Impact:** LOW · **Dimension:** Patterns · **Where:** `src/commands/init.ts` (`IGNORED_SEGMENTS`)
**What:** run on this repository, `init` enables `sql-migrations` for `test/fixtures/**.sql`. **Why it matters:** the
user removes them by hand; nothing breaks, and ignoring `test` folders could hide real specs kept there.
**Decision:** accept: `init` output is a starting point that the user reviews; the stderr summary lists every file it used (auto)

### S2 [SUGGESTION] Overwrite check and write are two steps
**Impact:** LOW · **Dimension:** Patterns · **Where:** `src/commands/init.ts` (runInit)
**What:** existence is checked with `access`, then the file is written; a file created in between would be
overwritten. **Why it matters:** only a concurrent writer of the same path triggers it.
**Decision:** accept: a one-shot command run by a person or CI; not worth the extra error path (auto)

## Progress audit
- 1.1, 1.2: re-ran `COMPAT_REQUIRE_OASDIFF=1 npx vitest run test/e2e/acceptance.test.ts` (12 tests pass) and the gates.
- 2.1, 2.2: `npx vitest run test/commands/init.test.ts test/main.test.ts` pass; red run before the implementation recorded in the session (18 failures for "unknown command").
- 3.1-3.4: `npm run build && npm run test:pack` (4 tests), `actionlint` clean, `npm publish --dry-run` lists `dist/cli.js`, `LICENSE`, `README.md`.
- 4.1, 4.2, 4.4: `npx vitest run test/readme.test.ts` (10 tests); a mutation removing `move-table` from the README made it fail.
- Open Manual items: 3.5 (owner publishes), 4.3 (owner configures PETSEO from the README). Pending, not findings.

## Triage summary
Fixed: F1. Accepted: S1, S2. Deferred: -. Withdrawn: -.

## Lessons proposed
None.

## Decisions (auto)
- F1 → fix now (clear local fix).
- S1, S2 → accept (suggestions; fixes add behaviour or an error path without a realistic failure).
