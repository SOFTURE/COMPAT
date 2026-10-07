# Implementation review: seed-layer

Scope: full · Date: 2026-10-07 · Commits: 5024773..0133880 · Gates: typecheck ✓ lint ✓ test ✓ (340 passed, 2 skipped) · build ✓ test:pack ✓

## Verdict
Ready after fixes. An independent read-only reviewer re-ran every gate, mapped each phase to its commit, broke five
rules in a scratch copy (each turned a test red) and probed realistic seed scripts. One critical gap (T-SQL scripts
without semicolons lost whole statements, a silent false `safe`), three warnings and two suggestions were found; all
were fixed in 0133880 and the gates were re-run green.

## Dimensions
| Dimension | Verdict | Findings |
| --- | --- | --- |
| Plan coverage | PASS | - |
| Correctness | FAIL → fixed | F1, F2, F3, F4 |
| Tests | PASS (mutation check: 5/5 red) | - |
| Patterns | PASS (mirrors sql-migrations: source loop, fail closed, accept notes) | F5 |
| Security | PASS (read-only git trees, relative globs without `..`) | - |
| Scope | PASS (`src/sql/`, `src/config/` untouched; one registry line) | - |
| Language | PASS (no non-English text in the diff) | - |

## Plan coverage
| Phase | Commit | Delivered | Notes |
| --- | --- | --- | --- |
| 1 Seed statement reader | e9ea7f7 | yes | all listed cases incl. 2000-row timing and `E'...'` |
| 2 Seed diff and classification | 2107ce1 | yes | finding table matches `SEED_RULE_CLASSES` |
| 3 Seed layer, config and F6 | beb2b3a | yes | F6 exits 0 with `--fail-on needs-action` in both dialects |

Files: planned and changed 18 · unplanned 0 · planned, not changed 0.

## Findings

### F1 [CRITICAL] T-SQL statements without semicolons vanish
**Impact:** MEDIUM · **Dimension:** Correctness · **Where:** `src/layers/seed/seed-statements.ts` (readSequence)
**What:** `splitStatements` splits only on `;` and `GO`; semicolons are optional in T-SQL. `SET IDENTITY_INSERT ... ON` +
`INSERT` + `TRUNCATE` without `;` gave 0 findings; `SET NOCOUNT ON` + changed `MERGE` lost the `MERGE`.
**Why it matters:** a destructive or overwriting seed passes the gate.
**Fix:** split a T-SQL piece again at a line that starts with a statement word, at top level, outside quotes and
`CASE ... END`, not right after a `MERGE` clause's `THEN`; `SET` only for session options and variables.
**Decision:** fix now: `findNextTsqlStatement` + tests "splits T-SQL statements written without semicolons" (0133880)

### F2 [WARNING] Moving or renaming a seed file hides value changes
**Impact:** MEDIUM · **Dimension:** Correctness · **Where:** `seed-layer.ts` per-path classification
**What:** rows were compared per file; a moved upsert row with a new value read as `seed-file-removed` + `row-added`.
**Fix:** compare rows and statements across every file of a source, keeping each row's path for evidence.
**Decision:** fix now: `classifySeedSource` replaces `classifySeedFile` + test "compares rows across the files of a source" (0133880)

### F3 [WARNING] An edited insert-only MERGE reads as safe
**Impact:** LOW · **Dimension:** Correctness · **Where:** `classify.ts` compareOther
**Fix:** apply the edited-query rule to `merge-query` that only inserts.
**Decision:** fix now: `isInsertOnlyQuery` + test (0133880)

### F4 [WARNING] Unrecognised writes stay silent
**Impact:** MEDIUM · **Dimension:** Correctness · **Where:** `seed-statements.ts` readWrite
**What:** CTE writes, PL/pgSQL `FOR ... LOOP` and T-SQL `WHILE ... BEGIN ... END` bodies gave no finding; the plan's
promise to record such gaps in the backlog was not kept.
**Fix:** read `WHILE` and loop bodies; a statement that still holds a top-level write word becomes `unknown-write`, and
a new one is `unreadable-write` `needs-action`; record CTE parsing in the backlog.
**Decision:** fix now: loops, `unknown-write`/`unreadable-write`, backlog entry in `context/backlog/later-layers.md` (0133880)

### F5 [SUGGESTION] A keyword-case change reads as a changed row
**Impact:** LOW · **Dimension:** Patterns · **Where:** `normalizeSql`
**Fix:** uppercase text outside quotes.
**Decision:** fix now: test "ignores a change of keyword case" (0133880)

### F6 [SUGGESTION] Two guard heuristics were generous
**Impact:** LOW · **Dimension:** Correctness · **Where:** `WHERE_NOT_EXISTS`, block guards
**What:** any `WHERE NOT EXISTS` counted as a guard; a row added under a new table-wide guard of an already seeded
table read as `safe`.
**Fix:** require the subquery to read the target table; a new guard that names no key column on a table the base
seeded → `row-added-skipped`.
**Decision:** fix now: `isGuardedQuery`, `isRowGuard` + tests (0133880)

## Progress audit
Every `- [x]` points at its phase commit (SHAs updated after the rebase onto the CMP-2 review fixes); each gate and
the F6 CLI run were reproduced in this review. No Manual items.

## Triage summary
Fixed: F1, F2, F3, F4, F5, F6. Accepted: -. Deferred: CTE row-level parsing (backlog). Withdrawn: -.

## Lessons proposed
- Seed and migration readers for T-SQL must not rely on `;`: a statement word at the start of a line also ends a
  statement (applies to any future T-SQL reader).

## Decisions (auto)
- F1 → fix now (clear local fix; it blocked the change's intent).
- F2, F3, F4 → fix now (local fixes that remove silent `safe` paths).
- F5, F6 → fix now (under ~20 lines each, risk-free).
