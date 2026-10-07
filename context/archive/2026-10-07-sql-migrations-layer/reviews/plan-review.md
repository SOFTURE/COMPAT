# Plan review: sql-migrations-layer

Reviewed: plan.md @ 2026-10-07. Mode: deep (independent read-only reviewer; core decoding checked with node 22 in a
scratch directory; EF Core output shapes checked from knowledge of the EF Core 6-9 generators, confidence given per
finding). Verdict: ready after fixes.
Findings: 1 critical, 3 warning, 3 suggestion.
Grounding: 9/9 paths, 9/10 symbols (`createRepo` could not commit non-UTF-8 bytes; see S2), 3/3 commands.

## Lenses
| Lens | Result |
| --- | --- |
| Coverage and end state | FAIL (C1), WARN (W1) |
| Slicing | PASS |
| Verifiability | WARN (W1: the F4-only revision fixture was unspecified) |
| Data and migrations | PASS (not applicable) |
| Tests | WARN (W1, W2, S2) |
| Security | PASS (relative paths without `..`; reads come from the git tree only) |
| Lean | PASS |
| Fit | WARN (W3); the core change keeps `utf8` as the `runProcess` default and `readFile` has no other `src/` caller |
| Cost and defaults | PASS |
| Scope | PASS (one registry line, `config.ts` untouched) |
| Reuse | PASS |
| Lessons | PASS (none recorded) |
| Progress format | PASS |

## Findings

### C1: F5 gives 79 findings with real EF Npgsql output, not one
- **Severity:** CRITICAL. **Effort:** low. **Lens:** Coverage. **Where:** Key decisions "Explicit ids", phase 2 step 2, Done-when 3.3.
- **Problem:** EF's base generator writes one `INSERT ... VALUES (...)` per seeded row (Npgsql inherits it), so 79 rows give 79 findings; only SqlServer batches rows.
- **Fix:** merge explicit-id matches per (migration, table) into one finding with the id range and row count; the Npgsql fixture uses one insert per row; classify test with three single-row inserts.
- **Decision:** Fix now (applied).

### W1: The EF fixtures and rules assumed idealised shapes
- **Severity:** WARNING. **Effort:** medium. **Lens:** Coverage, Tests, Verifiability. **Where:** research, Critical details, phase 2 and 3 tests.
- **Problem:** (a) the SqlServer guard spans several lines in EF 7+; (b) `IDENTITY_INSERT` is wrapped in `IF EXISTS (...)`; (c) seed inserts and filtered indexes can be multi-line `EXEC(N'...')`; (d) Npgsql `EnsureSchema` puts `IF NOT EXISTS(...) THEN CREATE SCHEMA ...; END IF;` inside the guard body; (e) a custom history table name fails the layer; (f) no F4-only revision fixture.
- **Fix:** whitespace-tolerant guard regex keyed on the migration id; strip a leading T-SQL `IF <cond>` and a PL/pgSQL `IF <cond> THEN`, drop `END IF`; optional `historyTable` for EF sources; fixtures in EF 8 output shape for both providers, plus `revision-f4.sql`; tests for (a)-(d).
- **Decision:** Fix now (applied).

### W2: The created-table pre-pass ignored order
- **Severity:** WARNING. **Effort:** medium. **Lens:** Coverage, Tests. **Where:** Key decisions "Tables created by the new migrations".
- **Problem:** a drop-and-recreate of an existing table was downgraded to `safe`; `CREATE TABLE IF NOT EXISTS` of an existing table downgraded everything; a renamed new table read as existing; `DROP VIEW v; CREATE VIEW v` read as `breaking`.
- **Fix:** walk statements in order; a table counts as created from its `CREATE` on, only when no earlier new statement touched it and, for `IF NOT EXISTS`, when no base migration of the source creates it; a rename of a created table carries the new name; a dropped object that the new migrations create again is `needs-action` `object-redefined`; tests per case.
- **Decision:** Fix now (applied).

### W3: `add-column` and `sp_rename` misread common SqlServer statements
- **Severity:** WARNING. **Effort:** low. **Lens:** Fit. **Where:** Rules table.
- **Problem:** `ADD DEFAULT N'' FOR [c]` and `ADD CONSTRAINT [DF_x] DEFAULT 0 FOR [c]` could read as `add-column`; `sp_rename ..., N'INDEX'` with a custom name could read as `rename-table`.
- **Fix:** constraint keywords (including `DEFAULT` and `PERIOD`) never become a column; `sp_rename` with any third argument other than `OBJECT`/`COLUMN` is silent; rules tests for each.
- **Decision:** Fix now (applied).

### S1: The scanner helper contracts omitted the dialect
- **Severity:** SUGGESTION. **Effort:** low. **Lens:** Fit. **Where:** phase 1 step 1.
- **Fix:** `splitTopLevel(text, dialect, separator)` and `findClosingParen(text, openIndex, dialect)`.
- **Decision:** Fix now (applied).

### S2: UTF-16 test helper and decoding edge cases
- **Severity:** SUGGESTION. **Effort:** low. **Lens:** Tests. **Where:** phase 1 steps 3-4.
- **Problem:** the repo helper wrote strings only; `runGit` could not pass the encoding; `swap16` throws on odd lengths; CRLF scripts must still split at `GO\r`.
- **Fix:** helper accepts `Buffer`; `runGit` options; UTF-16BE via `TextDecoder`; tests for an odd-length file and a CRLF `GO` script.
- **Decision:** Fix now (applied).

### S3: The folder glob join breaks on `.` or a trailing slash
- **Severity:** SUGGESTION. **Effort:** low. **Lens:** Fit. **Where:** phase 3 step 3.
- **Fix:** normalise `path` (trailing `/` removed, `.` is the repository root); config test.
- **Decision:** Fix now (applied).
