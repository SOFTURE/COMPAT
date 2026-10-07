# Research: seed-layer

Input: change.md, roadmap CMP-3, archived research of backward-compat-checker (§4 layer 4, F6). Depth: normal.
Snapshot: df12940 on claude/project-thread-f6wtg4 (stacked on CMP-2 branch claude/project-thread-balvwr), 2026-10-07 11:41 CEST.

## Summary
- A layer is a folder with a `z.strictObject` config schema, `defineLayer(...)` and one registry line
  (`src/layers/layer.ts:20-34`, `src/layers/registry.ts:6`); the config schema composes itself from the registry
  (`src/config/config.ts:13-24`), so `config.ts` needs no edit.
- CMP-2 delivered the shared scanner the seed layer needs: `splitStatements`, `splitTopLevel`, `findClosingParen`,
  `maskComments`, `createLineIndex` (`src/sql/statements.ts:127-265`) and name parsing (`src/sql/identifiers.ts:20-46`).
  Tuples of a multi-row `VALUES` list can be read with `findClosingParen` + `splitTopLevel`, exactly as
  `readValues` does for explicit ids (`src/layers/sql-migrations/rules.ts:403-417`).
- The sql-migrations rule set recognises `UPDATE`, `DELETE`, `TRUNCATE`, `MERGE` and `INSERT` heads
  (`rules.ts:103-107`) but has no notion of a conflict guard, a row key or a diff between two versions of one file;
  its `insert-explicit-id` logic is about identity sequences, not about idempotency. The seed layer needs its own
  statement reader; the head patterns are small enough to restate.
- Seed files are not migrations: the same file runs on every deploy, so the layer must diff the base and revision
  versions of each file (statement by statement, row by row) instead of taking only new files.
- No PETSEO `seed.sql` is available in this environment; F6 (`seed.sql:493-511`: three new `TermsChange` templates
  under `ON CONFLICT DO UPDATE`) is reproduced as a fixture from the archived research description.
- No SOFTURE module applies. No data, no external tool.

## Current state
- `check` runs every enabled layer with `{ config, base, revision, ... }` (`src/layers/layer.ts:5-14`); a layer
  returns `ran` / `skipped` / `failed` with findings and notes (`src/model/finding.ts:32-36`). `failed` findings still
  gate (`src/model/finding.ts:35`).
- `RefTree.listFiles(globs)` lists repository-relative paths at a commit, `readFile(path)` returns the decoded text
  or `null` when absent, BOM-aware (`src/git/ref-tree.ts:14-23`, `decodeText` at `:32-38`).
- `splitStatements(text, dialect)` returns comment-masked statements with true 1-based lines and offsets; SQL Server
  `GO` lines split batches; a procedure/function/trigger/view batch stays whole (`src/sql/statements.ts:195-228`).
  `BEGIN`/`END` are not tracked, so a T-SQL `IF ... BEGIN a; b; END` becomes three statements: `IF ... BEGIN a`,
  `b`, `END`.
- `parseName(raw, dialect).key` gives a lowercase `schema.table` with the default schema filled in
  (`src/sql/identifiers.ts:30-37`).
- The sql-migrations layer shows the source loop, fail-closed reading, notes and accept handling to mirror
  (`src/layers/sql-migrations/sql-migrations-layer.ts:10-63`, `classify.ts:185-202`, `sources.ts:40-80`).
- Postgres `DO $tag$ ... $tag$` blocks and T-SQL `IF <cond>` prefixes are unwrapped by private helpers in
  `rules.ts:429-472`; they are not exported.

## Affected surface
| Area | Files | Why |
| --- | --- | --- |
| New layer | `src/layers/seed/*` | owned by this change (change.md Constraints) |
| Registry | `src/layers/registry.ts` | one line |
| Tests | `test/layers/seed/*`, `test/e2e/seed.test.ts`, `test/fixtures/seed/*` | new |
| Backlog | `context/backlog/later-layers.md` | known gaps found during the change |

## Data
None. The layer reads two git trees; it never connects to a database.

## Tests
- vitest; `npm test` runs everything, gates from `context/workflow.json` (typecheck, lint, test).
- Temp git repos: `test/helpers/git-repo.ts` (`createRepo`, `writeRepoFile`); end-to-end via `main([...], io)` with
  `createIo` (`test/e2e/sql-migrations.test.ts:19-37`). Layer-level tests open `RefTree`s directly
  (`test/layers/sql-migrations/sql-migrations-layer.test.ts:14-45`).
- No coverage for seeds yet.

## Patterns to follow
- Config: `z.strictObject`, discriminated unions for alternatives, relative paths without `..`
  (`src/layers/sql-migrations/config.ts:7-28`), unique source names (`config.ts:63-72`).
- Every source is checked even when one fails; errors are joined into a `failed` result that keeps findings
  (`sql-migrations-layer.ts:18-37`).
- Accept entries keep the class and set `accepted.reason`; notes report each entry's match count and unused entries
  (`classify.ts:185-202`, `sql-migrations-layer.ts:52-60`).
- Findings: `scope` = source name, `subject` = `<id>: <object>`, evidence at the revision with `path` and `line`.

## Prior work
- `context/archive/2026-10-07-backward-compat-checker/research.md:25,99`: F6 and the layer sketch ("flags
  `UPDATE`/`DELETE`/`TRUNCATE` outside `ON CONFLICT` / `MERGE` guards, and a removed upsert").
- `context/changes/sql-migrations-layer/plan.md`: the scanner was built for this change ("CMP-3 compares tuples
  with it").
- Memory/lesson from CMP-4: hand-written scanners must cover all literal forms and fail on what they cannot parse
  rather than read as `safe`.

## SOFTURE modules
Not applicable: no generic capability (auth, mail, billing, ...) is involved.

## Risks
- **A changed row read as removed + added** (likely if the row key is wrong): the change would look `safe`. Mitigation:
  key rows by the conflict target, the `MERGE ... ON` equality columns, or the first column, and test each.
- **Statement shapes the reader does not know** (e.g. `INSERT ... SELECT` with CTEs, `COPY`): must stay silent or be
  conservative, never `safe` by accident.
- **T-SQL `IF NOT EXISTS (...) BEGIN ... END` blocks** are split into several statements by the scanner; a guard on
  the first statement must carry to the statements up to the matching `END`, or guarded inserts read as unguarded
  (noise, not a missed risk).
- **`MERGE ... WHEN NOT MATCHED BY SOURCE THEN DELETE`**: removing a tuple deletes the row; must not read as the
  harmless "no longer seeded".
- **Collisions:** CMP-4 and CMP-5 add their own registry line in parallel branches; a trivial merge conflict on
  `src/layers/registry.ts`.

## Relevant lessons
`context/foundation/lessons.md` does not exist. Project memory (CMP-4 lesson): scanners must handle every literal
form and fail closed on input they cannot read; applied to file reading (missing configured file fails the source).

## Answers to unknowns
- Roadmap unknowns: none listed. Implicit questions:
- *Which statements are "the same" across refs?* Row-bearing statements (`INSERT ... VALUES`, `MERGE ... USING
  (VALUES ...)`) are compared per table and row key; every other statement by its whitespace-normalised text
  (decided in plan).
- *Reuse of the splitter?* Yes: `splitStatements`, `splitTopLevel`, `findClosingParen`, `parseName` cover tokenising,
  tuples and names (`src/sql/statements.ts`, `src/sql/identifiers.ts`).
- *Dialects?* Both handled by the scanner; dialect-specific shapes: Postgres `ON CONFLICT`, `DO` blocks,
  `IF ... THEN ... END IF`; SQL Server `IF NOT EXISTS ... BEGIN ... END`, `MERGE` (also Postgres 15+).

## Open questions
- Row key when no conflict target is given → decided (auto): first column of the insert list; recorded in plan.
- Unchanged unguarded inserts already in the base → decided (auto): silent; the layer reports changes, and the base
  already ran them on every deploy.
- `TRUNCATE` class → answered by change.md: `needs-action` (not `breaking` as in migrations).

## Decisions (auto)
- Depth → normal (no data, no money, read-only analysis of two git trees).
- Focus → statement shapes of seed scripts and the diff model; no subagents (the area is two folders the author
  already read in full).
