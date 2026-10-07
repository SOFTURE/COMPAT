# Implementation review: sql-migrations-layer

Reviewed: all phases, `ef1589e..df12940`, 2026-10-07. Mode: full (independent read-only reviewer; reproductions in a
scratch copy of the repository). Verdict before triage: not ready (1 critical). Verdict after fixes: ready.
Findings: 1 critical, 6 warning, 3 suggestion. All fixed in the review-fix commit.
Gates on df12940: typecheck, lint, tests (259/259) green; after fixes 279/279.

## Plan adherence
Every phase has its commit (p1 86e292e, p2 8861b89, p3 400e1ab) and progress commit; every planned file and test
exists; contract drift is limited to renames (`matchStatement` takes a context, `classifyMigrations` takes the source
name and dialect instead of the source).

## Lenses
| Lens | Result |
| --- | --- |
| Plan adherence | PASS |
| Scope | PASS (one registry entry; `config.ts` untouched) |
| Progress honesty | PASS |
| Correctness | FAIL before fixes (C1, W1, W2, W3, W6) |
| Performance | WARN before fixes (W4, W5) |
| Tests | WARN before fixes (none of C1, W1-W6 covered) |
| Data and migrations | PASS (not applicable) |
| Security | PASS |
| Architecture and patterns | PASS (S3 on the parameter-count convention) |
| UTF-16 core change | PASS |
| Lessons | PASS |

## Findings

### C1: keyword tests read inside strings and quoted names, so a required column read as `safe`
- **Severity:** CRITICAL. **Effort:** low. **Lens:** Correctness. **Where:** `src/layers/sql-migrations/rules.ts` `matchAddition`.
- **Problem:** `ADD COLUMN c text COLLATE pg_catalog."default" NOT NULL` (pgAdmin output), `CHECK ([c] <> N'default')` and a type named `"identity"` counted as a default value.
- **Fix:** `maskLiterals` in `src/sql/statements.ts` blanks strings, quoted identifiers and dollar bodies before the keyword tests; rules tests for the three inputs and a `'NOT NULL'` inside a CHECK.
- **Decision:** Fix now (applied).

### W1: wrapper unwrapping lost recognised statements
- **Severity:** WARNING. **Effort:** medium. **Lens:** Correctness. **Where:** `rules.ts` `DO_BLOCK`, `getDoBody`, `IF_THEN`, `IDENTITY_INSERT_ON`.
- **Problem:** a `RAISE EXCEPTION` cut the DO body; `LANGUAGE` after the body, `ELSE`/`ELSIF` branches and an `EXEC` literal starting with `SET IDENTITY_INSERT` hid a `DROP TABLE`.
- **Fix:** the DO body runs from its first `BEGIN` to its last `END`; `LANGUAGE` is allowed on either side; `IF/ELSIF ... THEN`, `ELSE` and `BEGIN <statement>` are unwrapped, `EXCEPTION WHEN` handlers are skipped; `SET IDENTITY_INSERT` is anchored and reads `ON`/`OFF`; one classify test per input.
- **Decision:** Fix now (applied).

### W2: `object-redefined` ignored order
- **Severity:** WARNING. **Effort:** low. **Lens:** Correctness. **Where:** `classify.ts`.
- **Problem:** `CREATE OR REPLACE VIEW v` followed by `DROP VIEW v` read as a redefinition.
- **Fix:** every statement gets a walk position; a drop is a redefinition only when the object is defined later; test for create-then-drop.
- **Decision:** Fix now (applied).

### W3: EF script statements outside the guards were ignored
- **Severity:** WARNING. **Effort:** medium. **Lens:** Correctness (fail closed). **Where:** `ef-script.ts`.
- **Problem:** SQL appended between or after the guarded blocks never reached the rules.
- **Fix:** `parseEfScript` returns `unguarded` statements (bookkeeping and transaction control removed); the source reader reports those that the base script did not have as the migration `(outside migration guards)`; tests per dialect and in the source reader.
- **Decision:** Fix now (applied).

### W4: explicit-id merging was quadratic and large inserts overflowed the stack
- **Severity:** WARNING. **Effort:** low. **Lens:** Performance, Correctness. **Where:** `classify.ts`, `rules.ts` `describeExplicitIds`.
- **Fix:** a running summary `{ column, rows, range }` merged per insert, the message built once after the walk, min and max computed in a loop; tests with 150,000 single-row inserts and one 200,000-tuple insert.
- **Decision:** Fix now (applied).

### W5: SQL Server `splitStatements` was quadratic in GO lines
- **Severity:** WARNING. **Effort:** low. **Lens:** Performance. **Where:** `statements.ts` `isInCode`.
- **Fix:** binary search over the sorted ranges; a 5 MB script test.
- **Decision:** Fix now (applied).

### W6: T-SQL comma lists carried the wrong verb
- **Severity:** WARNING. **Effort:** low. **Lens:** Correctness. **Where:** `rules.ts` `matchAlterTable`.
- **Problem:** `DROP CONSTRAINT [DF_x], COLUMN [Name]` was silent; `DROP COLUMN [Name], CONSTRAINT [DF_x]` reported a column named `CONSTRAINT`.
- **Fix:** each item may switch between `COLUMN` and `CONSTRAINT`; rules tests for both orders.
- **Decision:** Fix now (applied).

### S1: `SET IDENTITY_INSERT ... OFF` was ignored
- **Severity:** SUGGESTION. **Effort:** low. **Where:** `rules.ts`, `classify.ts`.
- **Fix:** `OFF` removes the table from the identity set; test.
- **Decision:** Fix now (applied).

### S2: CTE-prefixed data changes were silent
- **Severity:** SUGGESTION. **Effort:** low. **Where:** `rules.ts`.
- **Fix:** the statement after `WITH ... AS (...)` is matched; test.
- **Decision:** Fix now (applied).

### S3: functions with more than three positional parameters
- **Severity:** SUGGESTION. **Effort:** low. **Where:** `buildFinding`, `matchInsert`, `scanQuoted`, `findBlockEnd`.
- **Fix:** options objects.
- **Decision:** Fix now (applied).
