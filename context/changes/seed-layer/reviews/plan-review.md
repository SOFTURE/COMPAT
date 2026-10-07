# Plan review: seed-layer

Reviewed: plan.md @ 2026-10-07. Mode: deep (independent read-only reviewer; scanner claims checked by running
`src/sql/statements.ts` under node). Verdict: ready after fixes.
Findings: 0 critical, 4 warning, 3 suggestion.
Grounding: 11/11 paths, 9/9 symbols, 3/3 commands

## Lenses
| Lens | Result |
| --- | --- |
| Coverage and end state | WARN (W1, W2) |
| Slicing | PASS |
| Verifiability | PASS |
| Data and migrations | PASS (not applicable) |
| Tests | WARN (W4, S2) |
| Security | PASS (read-only git trees; relative globs without `..`) |
| Lean | PASS |
| Fit | WARN (S3) |
| Cost and defaults | PASS |
| Scope | PASS (`src/sql/` untouched, one registry line) |
| Reuse | PASS |
| Lessons | PASS (CMP-4 memory lesson: fail closed on missing input) |
| Progress format | PASS |

## Findings

### W1 [WARNING] A row added to an existing IF NOT EXISTS block reads as safe
**Effort:** low. **Lens:** Coverage. **Where:** Key decisions "Guards and blocks", finding id `row-added`.
**Problem:** `IF NOT EXISTS (SELECT 1 FROM Roles) BEGIN INSERT 1; INSERT 4; END` checks once for the whole block; a
database where it is false skips the new row too, yet mode `ignore` made it `row-added` `safe`.
**Fix:** carry the normalised guard condition on each row; a new key under a condition the base already had →
`row-added-skipped` `needs-action`.
**Decision:** Fix now (applied) - Key decision "Block guards", finding id, contract field `guard`, Phase 2 tests.

### W2 [WARNING] Changes to an upsert's action are invisible
**Effort:** low. **Lens:** Coverage. **Where:** Key decisions "Row comparison".
**Problem:** a longer `DO UPDATE SET` list or a `WHEN NOT MATCHED BY SOURCE THEN DELETE` added to an unchanged
`MERGE` changed no compared field, so both stayed silent although they overwrite or delete production rows.
**Fix:** compare the normalised action text per row; a newly deleting `MERGE` → `delete-data`.
**Decision:** Fix now (applied) - contract field `action`, Key decisions "Row comparison" and "`MERGE` gains `BY
SOURCE DELETE`", Phase 2 tests.

### W3 [WARNING] Repeated keys under the first-column fallback are undefined
**Effort:** medium. **Lens:** Coverage. **Where:** Key decisions "Row key".
**Problem:** junction tables and `ON CONSTRAINT` on a composite key give many rows per fallback key; a map collapses
them and can hide a `row-deleted`.
**Fix:** when keys repeat on either side, compare that table's rows whole; an added row under an upsert is then
`row-changed`.
**Decision:** Fix now (applied) - Key decision "Repeated keys", Phase 2 tests.

### W4 [WARNING] A DO body with a nested block drops statements
**Effort:** low. **Lens:** Tests. **Where:** Key decisions "`DO` blocks", `rules.ts:460-470` pattern.
**Problem:** ending the body at the first `EXCEPTION` loses every statement after an inner
`BEGIN ... EXCEPTION ... END`.
**Fix:** count `BEGIN`/`CASE` ... `END` depth and stop only at the body's own `EXCEPTION`/`END`; a bare `BEGIN` opens a
plain block; add tests, plus T-SQL `END END` and `END` glued to the next `IF NOT EXISTS`.
**Decision:** Fix now (applied) - Key decision "`DO` blocks", Phase 1 tests.

### S1 [SUGGESTION] An edited guarded query insert reads as safe
**Effort:** low. **Lens:** Coverage. **Where:** Key decisions "Non-row statements".
**Fix:** a new `insert-query` (`ignore`) while the base's one for the same table is gone → `row-change-ignored`.
**Decision:** Fix now (applied) - Key decision "Edited guarded query insert".

### S2 [SUGGESTION] Per-tuple `findClosingParen` is quadratic on large seeds
**Effort:** low. **Lens:** Tests. **Where:** Phase 1, `src/sql/statements.ts:252-254` tokenises the whole text.
**Fix:** close each tuple with a linear scan from its `(`; test 2000 rows under a time bound.
**Decision:** Fix now (applied) - Phase 1 tests.

### S3 [SUGGESTION] Draft code ahead of the plan exposes `keyColumns`
**Effort:** low. **Lens:** Fit. **Where:** Phase 1 contract.
**Fix:** add `keyColumns` to the contract and let the Phase 1 tests drive the draft.
**Decision:** Fix now (applied) - contract updated; the draft was test-driven before its commit.

## Triage summary
Fixed: W1, W2, W3, W4, S1, S2, S3. Accepted: -. Deferred: -. Dismissed: -. Verdict after triage: ready after fixes.

## Decisions (auto)
- W1 Row added to an existing guard block → Fix now (clear fix, prevents a false `safe`).
- W2 Upsert action changes invisible → Fix now (clear fix, prevents silent overwrites and deletes).
- W3 Repeated keys → Fix now (whole-row comparison is the safer reading).
- W4 Nested DO blocks → Fix now (cheap, prevents silent loss).
- S1, S2, S3 → Fix now (cheap).
