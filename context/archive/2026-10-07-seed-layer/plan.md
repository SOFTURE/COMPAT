# Plan: seed-layer

Input: change.md, research.md. Complexity: medium (3 phases; one pure statement reader, one pure diff, one thin
layer; no external tool, no data).

## Goal
With a `seed` entry in `compat.config.json`, `softure-compat check --base <ref> --revision <ref>` reads, per configured
source, every seed file (scripts that run on every deploy) at both refs and reports what the revision's version does
to rows that already exist, with the source name as scope, `<file>: <table>` as subject and `path:line` evidence:

- rows added under a conflict guard (`ON CONFLICT DO UPDATE/NOTHING`, `MERGE ... WHEN NOT MATCHED`, T-SQL or
  PL/pgSQL `IF NOT EXISTS`) are `safe`;
- a row whose values changed under `ON CONFLICT DO UPDATE` / `MERGE ... WHEN MATCHED THEN UPDATE` is `needs-action`
  (it overwrites production rows); under `DO NOTHING` it is `needs-action` too (existing databases never get it);
- a row that is no longer seeded is `safe` information (the row stays), unless the revision's `MERGE` deletes rows
  missing from its source, which makes it `needs-action`;
- new or changed inserts without a conflict guard, and new `UPDATE`, `DELETE`, `TRUNCATE` statements, are
  `needs-action`.

Both dialects (`postgres`, `sqlserver`) work. Research F6 (three new `TermsChange` templates under
`ON CONFLICT DO UPDATE`, nothing updated or deleted) gives only `safe` findings and exit code 0, also with
`--fail-on needs-action`.

**Out of scope:** a database connection or the production row state; `COPY`/`BULK INSERT` and dynamic SQL
(`EXEC(N'...')`), which stay silent; the sql-migrations layer and the shared scanner (`src/sql/`, owned by CMP-2,
used as is); README and `init` (CMP-6); dialects other than Postgres and SQL Server.

## Approach
**Starting point:** a layer is `src/layers/<name>/` with a strict zod schema, `defineLayer` and one registry line
(`src/layers/layer.ts:20-34`, `src/layers/registry.ts:6`). CMP-2's scanner splits a script into comment-masked
statements with true lines (`src/sql/statements.ts:195-228`) and reads tuples (`splitTopLevel`, `findClosingParen`,
`:231-265`); `parseName` gives a comparable table key (`src/sql/identifiers.ts:30-37`). The scanner does not track
`BEGIN`/`END`, so a T-SQL `IF ... BEGIN a; b; END` arrives as three statements.

**Chosen:** a seed-specific statement reader (pure, in `src/layers/seed/`) that turns each statement into a typed
seed statement (rows with keys and a conflict mode, or a non-row statement with normalised text), a pure diff that
compares the two versions of one file (rows by table and key, other statements by normalised text), and a thin layer
that lists files, reads both refs and applies accept entries.
Rejected: reusing `matchStatement` from `src/layers/sql-migrations/rules.ts` - it classifies migrations, has no
conflict-guard or row-key notion, and its `IF` handling returns early on `SET IDENTITY_INSERT`; coupling the seed
layer to another layer's rules would also make CMP-2 edits ripple here. A plain line diff of the file - cannot tell an
added tuple from a changed one inside one multi-row `INSERT`.

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Layer name and config | `seed`: `{ sources: [{ name, dialect: 'postgres' \| 'sqlserver', files: glob[] (min 1), accept?: [{ id, object?, reason }] }] (min 1, unique names) }`, all `z.strictObject`; `files` are repository-relative globs (a plain path is a glob), no `..`, not absolute | PETSEO has one `seed.sql`; globs also cover a `seeds/` folder; mirrors the sql-migrations source list | change, plan |
| Missing input fails closed | a source whose globs match no file at the revision fails the layer, naming the source and globs; a read error fails the source | a typo must not read as `safe` (CMP-4 lesson) | research |
| Files compared | per path present at either ref; a path only in the base → one `seed-file-removed` `safe` finding (rows stay); a path only in the revision → diffed against an empty base | seeds are re-run, not applied once | plan |
| Seed statement kinds | `rows` (`INSERT ... VALUES`, `MERGE ... USING (VALUES ...)`), `insert-query` (`INSERT ... SELECT`/`WITH`/`DEFAULT VALUES`, or a `VALUES` list that cannot be read), `merge-query` (`MERGE` with another source or `WHEN MATCHED THEN DELETE`), `update`, `delete`, `truncate`; everything else is ignored | the statements a seed uses to write rows | change |
| Conflict mode | `update` (`ON CONFLICT ... DO UPDATE`, `MERGE ... WHEN MATCHED THEN UPDATE`), `ignore` (`ON CONFLICT ... DO NOTHING`, `MERGE` with only `WHEN NOT MATCHED`, `INSERT ... SELECT ... WHERE NOT EXISTS`, an `IF NOT EXISTS (...)` guard), `none` | what the statement does when the row already exists | change |
| Row key | `ON CONFLICT (cols)` target columns when all are in the column list; for `MERGE`, the source-side columns of `a.X = b.Y` pairs in `ON`; otherwise the first column (the first value when there is no column list) | a wrong key turns a changed row into removed + added (`safe`); seeds conventionally lead with the id | research risk |
| Row comparison | per file and table key: same key with the same column list, values (whitespace-normalised outside quotes), conflict mode, guard and action text (`ON CONFLICT ... DO UPDATE SET ...`, the `MERGE` `ON`/`WHEN` clauses) → unchanged; anything else differing → changed | a new column, a switch to `DO UPDATE` or a longer `SET` list also writes existing rows | plan, plan review W2 |
| Repeated keys | when a key repeats within a table on either side (junction tables, `ON CONSTRAINT` on a composite key, a generated first value), that table's rows are compared whole; an added row under `update` mode in a table the base already seeded is then `row-changed` (it cannot be told from a changed one) | a map keyed by a repeated key would hide rows | plan review W3 |
| Block guards | a row with mode `ignore` from an `IF NOT EXISTS (...)` guard carries the normalised condition; a new key under a condition the base already had → `row-added-skipped` `needs-action` | the condition is checked once per block; databases where it is already false never get the new row | plan review W1 |
| `MERGE` gains `BY SOURCE DELETE` | a table whose revision `MERGE` deletes missing rows while the base's did not → `delete-data` `needs-action` | it deletes every production row the seed does not list | plan review W2 |
| Edited guarded query insert | a new `insert-query` with mode `ignore` while the base's `insert-query` for the same table is gone → `row-change-ignored` | existing databases keep the old rows | plan review S1 |
| Non-row statements | compared as a multiset of normalised texts (whitespace collapsed outside quotes, no spaces around `(`, `)`, `,`, guard marker included); only revision statements missing from the base are classified; removed ones are silent | they already ran on every earlier deploy; a re-indented file must not report anything | plan |
| Unchanged unguarded inserts | silent | the base already ran them; the layer reports what the release changes | research |
| Guards and blocks | per statement sequence a block stack: `IF NOT EXISTS (...)` followed by `THEN` (Postgres) or `BEGIN` (SQL Server) opens a guarding block, any other `IF ... THEN`/`IF ... BEGIN`/`BEGIN [TRY\|CATCH]` a plain one; `ELSE` turns the top block non-guarding; `END IF` / `END [TRY\|CATCH]` closes one; a T-SQL `IF NOT EXISTS (...) <statement>` guards that statement only; text after an opener or after `END` on the same statement is read as a statement; a statement is guarded when any open block guards | the scanner splits `IF ... BEGIN a; b; END` into three statements (research) | research |
| `DO` blocks (Postgres) | the body between the first `BEGIN` and the `EXCEPTION` or `END` of that same block (nested `BEGIN`/`CASE` ... `END` counted; a bare `BEGIN` inside opens a plain block) is split and read with its own block stack, at most 3 levels deep, lines offset from the body | PETSEO-style seeds wrap guarded inserts in `DO $$` | research |
| Findings | table below; one finding per (file, table, id) for row findings, listing the row count and up to 5 keys, evidence at up to 5 distinct row lines; one finding per new non-row statement | readable for multi-row seeds (F6, 79-row style lists) | plan |
| `MERGE ... WHEN NOT MATCHED BY SOURCE THEN DELETE` | rows of that table missing from the revision → `row-deleted` `needs-action` instead of `row-removed` | removing a tuple deletes the row (research risk) | research |
| Accept allowlist | per source, matched on `id` + optional `object` (case-insensitive; the table as the report shows it, or the file path for `seed-file-removed`); accepted findings keep their class and do not gate; notes report counts and unused entries | mirrors `src/layers/sql-migrations/classify.ts:185-202` | plan |
| Shared files | `src/layers/registry.ts` gets one line; `src/config/config.ts`, `src/sql/*` untouched | change Constraints; CMP-2 owns `src/sql/` | change |

**Finding ids:**
| id | When | Class |
| --- | --- | --- |
| `row-added` | a key not in the base, mode `update` or `ignore` | safe |
| `row-removed` | a key only in the base, no deleting `MERGE` for the table | safe |
| `seed-file-removed` | a seed file only in the base | safe |
| `insert-query-added` | a new `insert-query` with mode `ignore`, or a new `merge-query` that only inserts | safe |
| `row-changed` | same key, differs, mode `update` | needs-action |
| `row-change-ignored` | same key, differs, mode `ignore`; an edited guarded query insert | needs-action |
| `row-added-skipped` | a key not in the base under an `IF NOT EXISTS` condition the base already had | needs-action |
| `row-deleted` | a key only in the base, the revision `MERGE` deletes rows missing from its source | needs-action |
| `insert-unguarded` | a new or changed row with mode `none`, or a new `insert-query` with mode `none` | needs-action |
| `upsert-query` | a new `insert-query` with mode `update`, or a new `merge-query` that updates | needs-action |
| `update-data`, `delete-data`, `truncate` | a new `UPDATE`, `DELETE` (also a new deleting `merge-query`, or a `MERGE` that newly deletes missing rows), `TRUNCATE` | needs-action |

**Critical details:**
- Line numbers: offsets inside an unwrapped statement (after `IF ... THEN`, inside a `DO` body, a tuple inside a
  `VALUES` list) are turned into lines by counting newlines from the statement start; the scanner keeps newlines in
  masked text, so this is exact.
- `ON CONFLICT` is searched only in the text after the last `VALUES` tuple (rows) so a value holding the words cannot
  change the mode.

## Phase 1: Seed statement reader
**Discipline:** TDD. **Files:** `src/layers/seed/seed-statements.ts`, `test/layers/seed/seed-statements.test.ts`

1. `src/layers/seed/seed-statements.ts`: `readSeedStatements(text: string, dialect: SqlDialect): SeedStatement[]`.
   Contract: `type ConflictMode = 'update' | 'ignore' | 'none'`; `type SeedRow = { key: string; values: string;
   line: number }`; `SeedStatement` is a discriminated union on `kind`:
   `{ kind: 'rows'; table: SqlName; columns: string[]; keyColumns: string[]; rows: SeedRow[]; mode: ConflictMode;
   deletesMissing: boolean; guard: string | null; action: string; line: number }`, `{ kind: 'insert-query'; table; mode; text; line }`, `{ kind: 'merge-query'; table; updates:
   boolean; deletes: boolean; text; line }`, `{ kind: 'update' | 'delete' | 'truncate'; table; text; line }`.
   Also exports `normalizeSql(text, dialect): string` (whitespace rule from Key decisions). Implements the kinds,
   modes, keys, guards, blocks and `DO` unwrapping from Key decisions using `splitStatements`, `splitTopLevel`,
   `findClosingParen` and `parseName`.

**Tests:** empty text; Postgres multi-row `INSERT ... VALUES ... ON CONFLICT ("Id") DO UPDATE SET` (3 rows, keys,
lines per tuple, mode `update`); `DO NOTHING`, `ON CONFLICT ON CONSTRAINT pk DO UPDATE` (key falls back to the first
column), no conflict clause (`none`); conflict target not in the column list → first column; a value containing
`'ON CONFLICT DO UPDATE'` in a plain insert stays `none`; an insert without a column list (key = first value);
`INSERT ... SELECT ... WHERE NOT EXISTS` (`insert-query`, `ignore`); `INSERT ... SELECT ... ON CONFLICT DO UPDATE`
(`update`); an unreadable `VALUES` list → `insert-query`; `MERGE INTO t AS tg USING (VALUES ...) AS s (Id, Name) ON
tg.Id = s.Id WHEN MATCHED THEN UPDATE ... WHEN NOT MATCHED THEN INSERT ...` (rows, `update`, key `Id`), with only
`WHEN NOT MATCHED` (`ignore`), with `WHEN NOT MATCHED BY SOURCE THEN DELETE` (`deletesMissing`), with a table
source (`merge-query`), with `WHEN MATCHED THEN DELETE` (`merge-query`, `deletes`); `UPDATE`, `DELETE FROM`,
`TRUNCATE TABLE`; T-SQL `IF NOT EXISTS (SELECT 1 FROM t WHERE Id = 1) INSERT ...` (`ignore`) and the
`IF NOT EXISTS (...) BEGIN INSERT ...; INSERT ...; END` block (both `ignore`, a following insert after `END` is
`none`); T-SQL `IF @x = 1 BEGIN INSERT ...; END` (not a guard); Postgres
`DO $$ BEGIN IF NOT EXISTS (...) THEN INSERT ...; END IF; INSERT ...; END $$` (first `ignore`, second `none`, lines
true); `ELSE` branch not guarded; `normalizeSql` collapses whitespace and keeps `'a  b'` and `[a  b]`; `GO` batches in
`sqlserver`; guard condition and action text recorded; a `DO` body with a nested `BEGIN ... EXCEPTION ... END`
block and a `CASE ... END` still reads the statements after it; T-SQL `END END` and `END` glued to the next
`IF NOT EXISTS ... BEGIN`; a 2000-row `VALUES` list with true lines in under a second (tuples are closed with a
linear scan from the tuple, not `findClosingParen` over the whole statement); a Postgres `E'it\'s'` value.

**Done when:**
- Automated: every listed case passes in `test/layers/seed/seed-statements.test.ts`; Gates green (typecheck, lint,
  test).

## Phase 2: Seed diff and classification
**Discipline:** TDD. **Files:** `src/layers/seed/classify.ts`, `test/layers/seed/classify.test.ts`

1. `src/layers/seed/classify.ts`: `export const SEED_LAYER = 'seed'`; `SEED_RULE_CLASSES` (the finding-id table);
   `classifySeedFile(options: { sourceName: string; path: string; base: SeedStatement[] | null; revision:
   SeedStatement[] | null; baseTree: Pick<RefTree, 'side' | 'ref' | 'commit'>; revisionTree: same }):
   ClassifiedFinding[]` where `ClassifiedFinding = { finding: Finding; object: string }` (`null` base = file new,
   `null` revision = file removed → `seed-file-removed`). Implements the row comparison, non-row multiset and the
   finding table from Key decisions; row findings are ordered by table first appearance, then id.
2. `applySeedAccept(classified, accept): { findings: Finding[]; usage: { entry; count }[] }` with the accept rule
   from Key decisions.

**Tests:** identical files → no finding; F6 shape (3 new keys under `DO UPDATE`) → one `row-added` `safe` naming 3
rows and their keys; reformatted file (whitespace, tuple order) → nothing; changed value under `DO UPDATE` →
`row-changed` with the key; under `DO NOTHING` → `row-change-ignored`; mode switch `DO NOTHING` → `DO UPDATE` with
the same values → `row-changed`; a new column in the column list → every row `row-changed`; key gone → `row-removed`
`safe` with base evidence; key gone under a revision `MERGE ... BY SOURCE DELETE` → `row-deleted`; new unguarded
row and changed unguarded row → `insert-unguarded`; unchanged unguarded insert → nothing; new `UPDATE`, `DELETE`,
`TRUNCATE` → their ids; an `UPDATE` present in both → nothing; the same `UPDATE` twice in the revision but once in the
base → one finding; new `insert-query` per mode and new `merge-query` per flag; file only in the base →
`seed-file-removed`; file only in the revision → rows are `row-added`; more than 5 keys → message says
"and N more" and evidence is capped at 5; accept by id, by id + object (case-insensitive), unused entry reported
with count 0; a longer `DO UPDATE SET` list → `row-changed`; a `BY SOURCE DELETE` added to an unchanged `MERGE` →
`delete-data`; a row added to an existing `IF NOT EXISTS` block → `row-added-skipped`, a per-row guard → `row-added`;
repeated keys: a junction row added under `DO NOTHING` → `row-added`, under an upsert → `row-changed` plus
`row-removed`; an edited guarded query insert → `row-change-ignored`.

**Done when:**
- Automated: every listed case passes in `test/layers/seed/classify.test.ts`; Gates green (typecheck, lint, test).

## Phase 3: Seed layer, config and F6 end to end
**Discipline:** TDD for config and layer behaviour, test-after for the registry line. **Files:**
`src/layers/seed/config.ts`, `src/layers/seed/seed-layer.ts`, `src/layers/registry.ts`,
`test/layers/seed/config.test.ts`, `test/layers/seed/seed-layer.test.ts`, `test/e2e/seed.test.ts`,
`test/fixtures/seed/f6-postgres/base.sql`, `test/fixtures/seed/f6-postgres/revision.sql`,
`test/fixtures/seed/f6-sqlserver/base.sql`, `test/fixtures/seed/f6-sqlserver/revision.sql`,
`context/backlog/later-layers.md`

1. `src/layers/seed/config.ts`: `seedConfigSchema` per Key decisions "Layer name and config"; types `SeedConfig`,
   `SeedSource`.
2. `src/layers/seed/seed-layer.ts`: `seedLayer = defineLayer({ name: SEED_LAYER, ... })`; per source: `listFiles`
   at both refs, fail when the revision matches nothing, read each path at both refs (`readFile`, errors name path
   and ref), `readSeedStatements`, `classifySeedFile`, `applySeedAccept`; every source is checked even when one fails
   (same shape as `sql-migrations-layer.ts:10-37`). Notes per source: `<n> file(s), <m> statement(s), <r> row(s)
   read at the revision` and accept usage.
3. `src/layers/registry.ts`: add `seedLayer` after `sqlMigrationsLayer`.
4. Fixtures: F6 per dialect: a base seed with existing `TermsChange`-style templates and other seeded tables, and a
   revision that adds three templates (Postgres `ON CONFLICT ("Id") DO UPDATE`; SQL Server `MERGE ... USING (VALUES
   ...)` with `WHEN MATCHED THEN UPDATE` and `WHEN NOT MATCHED THEN INSERT`) and changes nothing else.
5. `context/backlog/later-layers.md`: record the known gaps (dynamic SQL and `COPY` stay silent; the row key falls
   back to the first column).

**Tests:** config: minimal source parses; unknown key, empty `files`, absolute path, `..`, duplicate names, bad
dialect each fail with the field named. Layer (temp repo): a source matching no file at the revision → `failed`
naming it, and a second healthy source still reports its findings; a file removed at the revision →
`seed-file-removed`; notes count files, statements and rows; accepted finding keeps its class and carries the
reason. End to end per dialect (`main` with `--format json`): F6 → layer `ran`, only `safe` findings, one
`row-added` naming 3 rows, exit 0 with `--fail-on needs-action`; a revision that changes an existing template's
text → `row-changed` `needs-action` and exit 1 with `--fail-on needs-action`.

**Done when:**
- Automated: `npm test` passes the config, layer and end-to-end cases above; `softure-compat check` on the F6 fixture
  exits 0 with `--fail-on needs-action` in both dialects; `npm run build` and `npm run test:pack` pass; Gates green
  (typecheck, lint, test).

## Risks and rollback
- Wrong row key on an unusual seed → a changed row reads as removed + added. Mitigation: the key rule is tested per
  shape and documented in the finding message ("keyed by <columns>"); accept entries cover false positives. Rollback:
  remove the `seed` entry from the consumer config.
- Statement shapes the reader does not know stay silent → a missed risk, never a false `safe` on a known shape;
  recorded in the backlog.
- Registry merge conflict with CMP-4/CMP-5 (one line each): resolved at merge time by keeping every line.
- Each phase is additive inside `src/layers/seed/` plus one registry line; reverting a phase commit removes it
  cleanly.

## Decisions (auto)
- Complexity → medium (three thin phases, pure functions first).
- Config shape: `files` globs instead of a single `path` → globs (one path is a glob; a `seeds/` folder is common).
- Row key without a conflict target → first column (conventional id-first seeds; documented in messages).
- `ON CONFLICT DO NOTHING` with changed values → `needs-action` `row-change-ignored` (the author's edit never reaches
  existing databases, which is the kind of surprise the layer exists for).
- Unchanged unguarded inserts → silent (pre-existing, not introduced by the release).
- Removed non-row statements → silent (already applied; stopping them changes no rows).
- `TRUNCATE` → `needs-action` per change.md, not `breaking`.
- Dynamic SQL and `COPY` → silent, backlog.
- Plan review W1-W4, S1-S3 → all fixed in this plan (see `reviews/plan-review.md`).
- Impl review C1, W1-W3, S1-S2 → fixed after implementation, recorded here as drift from the phases above
  (see `reviews/impl-review.md`): T-SQL statements without `;` are split at line-leading statement words; rows and
  statements are compared across every file of a source (`classifySeedSource` replaces `classifySeedFile`); an edited
  insert-only `MERGE` is `row-change-ignored`; writes the reader cannot parse become `unknown-write` →
  `unreadable-write` `needs-action`; T-SQL `WHILE` and PL/pgSQL loop bodies are read; `normalizeSql` uppercases text
  outside quotes; `WHERE NOT EXISTS` guards only when it reads the target table; a row added under a new table-wide
  guard of an already seeded table is `row-added-skipped`.

## Progress

> `- [ ]` pending, `- [x]` done. A phase ends with ` — <commit sha>` on its done items. Never rename items.

### Phase 1: Seed statement reader

#### Automated
- [x] 1.1 Every listed case passes in `test/layers/seed/seed-statements.test.ts` — e9ea7f7
- [x] 1.2 Gates green (typecheck, lint, test) — e9ea7f7

### Phase 2: Seed diff and classification

#### Automated
- [x] 2.1 Every listed case passes in `test/layers/seed/classify.test.ts` — 2107ce1
- [x] 2.2 Gates green (typecheck, lint, test) — 2107ce1

### Phase 3: Seed layer, config and F6 end to end

#### Automated
- [x] 3.1 Config, layer and end-to-end cases pass under `npm test` — beb2b3a
- [x] 3.2 `softure-compat check` on the F6 fixture exits 0 with `--fail-on needs-action` in both dialects — beb2b3a
- [x] 3.3 `npm run build` and `npm run test:pack` pass — beb2b3a
- [x] 3.4 Gates green (typecheck, lint, test) — beb2b3a
