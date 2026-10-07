# Plan: sql-migrations-layer

Input: change.md, research.md. Complexity: medium (3 phases; one shared parser, one pure rule set, one layer; no
external tool, no data).

## Goal
With a `sql-migrations` entry in `compat.config.json`, `softure-compat check --base <ref> --revision <ref>` takes, per
configured source, only the migrations that exist in the revision and not in the base, splits them into statements,
and reports every recognised statement as a finding classified `safe`, `needs-action`, `rollback-risk` or
`breaking`, with the source name as scope, the migration id and object as subject, and `path:line` evidence at the
revision. Two source kinds work for both dialects (`postgres`, `sqlserver`): a folder of `.sql` files (drizzle, plain
scripts) and an EF Core idempotent script. Research F4 (only new schema and tables, with their indexes and foreign
keys) gives the layer verdict `safe`; research F5 (79 rows inserted into an existing table with explicit ids 418-496)
gives one `needs-action` finding whose message states the precondition that production `max(Id)` is below 418.
Unrecognised statements produce no finding. A shared scanner in `src/sql/` (statements, comments, strings, Postgres
dollar quoting, SQL Server `GO` batches and bracket identifiers) is ready for CMP-3. UTF-16 scripts (BOM) are decoded
correctly by `RefTree.readFile`.

**Out of scope:** Squawk or any other external linter (`context/backlog/later-layers.md`); a database connection or
the base schema; EF `Migrations/*.cs` folders (only the SQL the consumer generates); the `seed` layer (CMP-3);
README and `init` (CMP-6); other dialects (MySQL, SQLite).

## Approach
**Starting point:** a layer is a folder with a strict zod schema and `defineLayer` (`src/layers/layer.ts:20-34`)
plus one registry line (`src/layers/registry.ts:5`); the config schema composes itself (`src/config/config.ts:13-24`).
`RefTree.listFiles` and `readFile` give file lists and contents per ref (`src/git/ref-tree.ts:14-23`), but text is
decoded as UTF-8 by `runProcess` (`src/process/run-process.ts:76`). Research answers how EF marks migration ids:
a `__EFMigrationsHistory` guard per block, in a `DO $EF$` block (Npgsql) or an `IF NOT EXISTS ... BEGIN ... END`
block (SqlServer).

**Chosen:** an own single-pass scanner plus anchored regular-expression rules on comment-masked statements, organised
as pure functions (scanner, name parser, statement rules, migration classification) under a thin layer.
Rejected: `node-sql-parser` (research §3 option) - a full parser fails on the first construct it does not know
(`DO` blocks, `GO`, `sp_rename`, EF guards), so a whole script would fail instead of one statement staying silent, and
it adds a large dependency; Squawk - Postgres only and an external binary (change Constraints).

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Layer name and config | `sql-migrations`: `{ sources: [{ name, dialect: 'postgres' \| 'sqlserver', kind: 'folder', path, include? } \| { name, dialect, kind: 'ef-script', path, historyTable? }] (min 1, unique names), each with optional `accept: [{ id, migration, object?, reason }]` }`, all `z.strictObject` | one entry per source mirrors `openapi.apis`; the dialect cannot be guessed reliably from SQL | change, plan |
| Folder sources | `path` normalised (trailing `/` removed, `.` is the repository root); `include` globs relative to `path`, default `["**/*.sql"]`; migration id = path relative to `path`; migrations ordered by id | drizzle names sort by number; plain folders are usually numbered or dated | research |
| New migrations | folder: paths present in the revision and absent in the base; EF: ids guarded in the revision script and absent in the base script | change Intent | change |
| Edited or removed applied migrations | folder: same path with different content → `needs-action` `migration-modified`; path gone → `needs-action` `migration-removed`; EF: id gone → `needs-action` `migration-removed`; EF content differences of old ids are ignored | production already ran them; an edit never reaches it; an EF script is regenerated as a whole, so old blocks change with the EF version | plan |
| Missing input fails closed | folder with no matching file at the revision, EF script absent at the revision, or an EF script with text but no guard → layer `failed` naming the source and path | a typo in `path` or a wrong dialect must not read as `safe` | plan |
| EF script absent at the base | every guarded migration of the revision is new | the first release that commits the script | plan |
| EF guard | `IF NOT EXISTS` + `SELECT ... FROM <historyTable> WHERE <MigrationId> = '<id>'`, any whitespace and line breaks, quoted or bare names, `N'` prefix; `historyTable` defaults to `__EFMigrationsHistory` | EF 6 writes the SqlServer guard on one line, EF 7+ over several; a custom history table is an EF option | plan review W1 |
| Scanner | `splitStatements(text, dialect)` → `SqlStatement[] = { sql, line, offset }`; `;` ends a statement outside strings, quoted identifiers, comments and dollar quotes; `sqlserver`: a line holding only `GO [n]` ends a statement and a batch, and a batch that starts with `CREATE [OR ALTER] PROCEDURE\|PROC\|FUNCTION\|TRIGGER\|VIEW` stays one statement; comments are replaced by spaces with newlines kept so offsets and lines stay true | the rules need comment-free text with real line numbers; CMP-3 needs the same | change Constraints |
| Name matching | identifiers `"x"`, `[x]`, `` `x` ``, bare; compared case-insensitively without quotes, the default schema filled in (`public`, `dbo`) | Postgres folds unquoted names, EF quotes them; one key per table | plan |
| Rules | table below | the change.md rule set, refined for what EF and drizzle emit | change, research |
| Tables created by the new migrations | statements are walked in migration order; a table counts as created from its `CREATE TABLE` on, when no earlier new statement touched it and, for `CREATE TABLE IF NOT EXISTS`, when no base migration of the same source creates it; `RENAME TO` of a created table carries the new name; any later finding on a created table becomes `safe` with the reason in the message | EF and drizzle emit indexes, unique indexes and foreign keys for every new table (F4 must be `safe`), while a drop-and-recreate must stay `breaking` | research F4, plan review W2 |
| Redefined objects | a `drop-object` whose view, function, procedure, type or sequence the new migrations create again becomes `needs-action` `object-redefined` | `DROP VIEW v; CREATE VIEW v` is the usual redefinition, not a removal | plan review W2 |
| `safe` findings | one per recognised additive statement (schema, table, column, index) | the report shows what the release adds, as `openapi` does with `endpoint-added` | plan |
| SQL Server `ALTER COLUMN` | always `breaking` `alter-column` | the script repeats the full definition and cannot tell a widening from a narrowing or a type change; an old EF build reading a changed CLR type throws; the accept allowlist records a reviewed widening | plan |
| Explicit ids | one finding per (migration, table), merging every matching insert: row count, id range, evidence at the first insert; an `INSERT` into an existing table whose column list holds `id` (any quoting or case), or into a table under `SET IDENTITY_INSERT ... ON` earlier in the same migration → `needs-action` `insert-explicit-id`; numeric ids give the range and the precondition `max(id) < first`, other ids give "rows with these ids must not exist" | F5; EF `HasData` uses exactly these shapes | research F5 |
| Conditional wrappers | a leading T-SQL `IF <cond>` (balanced parentheses or a simple condition) and a PL/pgSQL `IF <cond> THEN` are stripped and the rest matched; `END IF` is silent; `SET IDENTITY_INSERT t ON` is found anywhere in a statement | EF wraps `EnsureSchema` and seed identity this way | plan review W1 |
| Dynamic SQL | `EXEC(N'<one literal>')` / `EXECUTE '<literal>'` (multi-line) and `IF <cond> EXEC(N'<literal>')` are unwrapped and the literal classified at the line of the `EXEC`; concatenated dynamic SQL stays silent | EF SqlServer wraps schema creation and filtered indexes this way | research |
| `DO` blocks (Postgres) | the body between the first `BEGIN` and `EXCEPTION` or the last `END` is split and classified | drizzle wraps foreign keys and enums; EF Npgsql wraps every operation | research |
| Accept allowlist | per source, matched on rule `id` + `migration` (exact) + optional `object` (case-insensitive); an accepted finding keeps its class, does not gate, and notes report counts and unused entries | mirrors `openapi` (`src/layers/openapi/classify.ts`) so reviewed false positives are recorded, not hidden | plan |
| UTF-16 | `runProcess` gets `stdoutEncoding?: 'utf8' \| 'latin1'` (latin1 is byte-lossless); `runGit` takes it as an option; `RefTree.readFile` reads with `latin1`, then decodes by BOM with `TextDecoder`: UTF-8 BOM → UTF-8 without it, `FF FE` → UTF-16LE, `FE FF` → UTF-16BE, none → UTF-8 | closes the core backlog item with the smallest core change | research, backlog |
| Shared files | `src/layers/registry.ts` gets one line; `src/config/config.ts` is untouched (it composes from the registry) | CMP-4 and CMP-5 change the same registry in parallel | change Constraints |

**Rules** (`postgres` and `sqlserver` unless marked; "existing" means not created by the new migrations):
| id | Statement | Class |
| --- | --- | --- |
| `create-schema` | `CREATE SCHEMA` | safe |
| `create-table` | `CREATE [UNLOGGED\|TEMP] TABLE` | safe |
| `add-column` | `ALTER TABLE t ADD [COLUMN] c ...` nullable, or `NOT NULL` with `DEFAULT`, identity, generated, serial or computed | safe |
| `add-required-column` | `ALTER TABLE t ADD [COLUMN] c ... NOT NULL` without a default | breaking |
| `create-index` | `CREATE INDEX` | safe |
| `add-unique-index` | `CREATE UNIQUE INDEX` on an existing table | needs-action |
| `add-constraint` | `ADD [CONSTRAINT n] PRIMARY KEY\|UNIQUE\|FOREIGN KEY\|CHECK\|EXCLUDE` on an existing table | needs-action |
| `drop-table` | `DROP TABLE` | breaking |
| `drop-column` | `ALTER TABLE t DROP [COLUMN] c` (`sqlserver`: every name of `DROP COLUMN a, b`) | breaking |
| `drop-object` | `DROP VIEW\|MATERIALIZED VIEW\|FUNCTION\|PROCEDURE\|PROC\|TYPE\|SEQUENCE\|SCHEMA` | breaking |
| `rename-table` | `ALTER TABLE t RENAME TO`; `sp_rename` of an object whose name does not start with `PK_`, `FK_`, `AK_`, `IX_`, `DF_`, `CK_`, `UQ_` | breaking |
| `rename-column` | `ALTER TABLE t RENAME [COLUMN] a TO b`; `sp_rename ..., 'COLUMN'` | breaking |
| `move-table` | `ALTER TABLE t SET SCHEMA`; `ALTER SCHEMA s TRANSFER` | breaking |
| `change-column-type` | `ALTER [COLUMN] c [SET DATA] TYPE` (`postgres`) | breaking |
| `alter-column` | `ALTER COLUMN c <definition>` (`sqlserver`) | breaking |
| `set-not-null` | `ALTER [COLUMN] c SET NOT NULL` (`postgres`) | breaking |
| `drop-not-null` | `ALTER [COLUMN] c DROP NOT NULL` (`postgres`) | rollback-risk |
| `drop-default` | `ALTER [COLUMN] c DROP DEFAULT` (`postgres`) | needs-action |
| `enum-value-added` | `ALTER TYPE e ADD VALUE` (`postgres`) | rollback-risk |
| `enum-value-renamed` | `ALTER TYPE e RENAME VALUE` (`postgres`) | breaking |
| `truncate` | `TRUNCATE [TABLE]` | breaking |
| `update-data` | `UPDATE` | needs-action |
| `delete-data` | `DELETE` | needs-action |
| `merge-data` | `MERGE` | needs-action |
| `insert-explicit-id` | see Key decisions | needs-action |
| `object-redefined` | see Key decisions | needs-action |
| `migration-modified`, `migration-removed` | see Key decisions | needs-action |

`DROP INDEX`, `DROP CONSTRAINT`, `RENAME CONSTRAINT`, index and constraint renames, `SET DEFAULT`, inserts without
explicit ids, `ADD DEFAULT ... FOR` and `ADD CONSTRAINT n DEFAULT`, `sp_rename` of an index or statistics, `CREATE VIEW`/`FUNCTION`, `SELECT setval(...)`, `START TRANSACTION`/`COMMIT` and everything else stay
silent. Every rule except `create-*`, `add-column` and `migration-*` becomes `safe` on a table the new migrations
created.

**Critical details:**
- EF segmentation works on the comment-masked whole script, not on split statements: a SqlServer guard block holds
  several `;`-terminated statements inside `BEGIN ... END`. The body of a guard runs from the end of its header to the
  last `END IF` (Npgsql) or `END` (SqlServer) before the next guard header or the end of the script; it is then split
  with the scanner and line numbers are offset from the body start. Statements that mention `__EFMigrationsHistory`
  are bookkeeping and skipped.
- Postgres `E'...'` strings use backslash escapes and `$tag$` only opens a dollar quote when the previous character
  cannot belong to an identifier (`a$b$` is a name, `$1` a parameter); getting either wrong swallows the rest of the
  script into one statement.

## Phase 1: Shared SQL scanner and UTF-16 decoding
**Discipline:** TDD. **Files:** `src/sql/statements.ts`, `src/sql/identifiers.ts`, `src/process/run-process.ts`,
`src/git/ref-tree.ts`, `test/helpers/git-repo.ts`, `test/sql/statements.test.ts`, `test/sql/identifiers.test.ts`,
`test/git/ref-tree-encoding.test.ts`,
`context/backlog/core.md`

1. `src/sql/statements.ts`: the scanner. Contract: `type SqlDialect = 'postgres' | 'sqlserver'`;
   `maskComments(text, dialect): string` (same length, comments replaced by spaces, newlines kept);
   `splitStatements(text, dialect): SqlStatement[]` with `SqlStatement = { sql: string; line: number; offset: number }`
   (`sql` masked and trimmed, `line` 1-based line of its first character, `offset` of that character in `text`, empty
   statements dropped); `splitTopLevel(text, dialect, separator = ','): string[]` splitting outside parentheses, strings and
   quoted identifiers (column lists, `VALUES` tuples, `ALTER TABLE` actions; CMP-3 compares tuples with it);
   `findClosingParen(text, openIndex, dialect): number` (-1 when unbalanced); `getLineAt(text, offset): number`. Rules per Key
   decisions "Scanner" and Critical details.
2. `src/sql/identifiers.ts`: `NAME_PATTERN` (a regex source for a possibly qualified identifier), `parseName(raw,
   dialect): SqlName = { parts: string[]; display: string; key: string }` (`key` lowercase `schema.table` with the
   default schema filled in, `display` unquoted as written), `unquoteIdentifier(raw)`, `unescapeSqlString(literal)`
   (`N'it''s'` → `it's`).
3. `src/process/run-process.ts`: optional `stdoutEncoding: 'utf8' | 'latin1'` (default `utf8`), applied when stdout is
   decoded. Nothing else changes.
4. `src/git/ref-tree.ts`: `readFile` reads with `latin1` and decodes with a local `decodeText(bytes)` per Key decisions
   "UTF-16". The `RefTree` doc comment names the supported encodings.
5. `context/backlog/core.md`: tick the UTF-16 item with the change id.

**Tests:** statements: empty input; one statement without a trailing `;`; `;` inside `'...'`, `''` escapes, `E'\''`,
`"a;b"`, `[a;b]`, `-- ;` and nested `/* /* ; */ */`; dollar quotes `$$`, `$EF$` with an inner `$$`-free body, `a$b$`
not a quote; `GO` and `go 2` lines split in `sqlserver` (also with CRLF line ends) but not inside a string or in `postgres`; a `CREATE PROCEDURE`
batch with inner `;` kept whole; lines and offsets of the second statement after a multi-line comment; drizzle
`--> statement-breakpoint` text; an unterminated string returns the rest as one statement. `splitTopLevel` with nested
parens and quoted commas; `findClosingParen` balanced and unbalanced. identifiers: `"Breeds"`, `public."Breeds"`,
`[dbo].[Breeds]`, `[a]]b]`, bare `Breeds` give the same key per dialect default schema; `display` keeps case.
ref-tree: a UTF-16LE file with BOM, a UTF-16BE file with BOM and a UTF-8 file with BOM all read as the same text;
a plain UTF-8 file with non-ASCII text (`é`) is unchanged; an odd-length UTF-16BE body decodes its stray byte as U+FFFD.
`test/helpers/git-repo.ts` accepts `Buffer` file contents for these.

**Done when:**
- Automated: the named scanner and identifier tests pass.
- Automated: `RefTree.readFile` returns the same text for UTF-8, UTF-8 with BOM, UTF-16LE and UTF-16BE (BOM) files.
- Automated: Gates green (typecheck, lint, test).

## Phase 2: Statement rules and migration classification
**Discipline:** TDD. **Files:** `src/layers/sql-migrations/rules.ts`, `src/layers/sql-migrations/classify.ts`,
`test/layers/sql-migrations/rules.test.ts`, `test/layers/sql-migrations/classify.test.ts`

1. `src/layers/sql-migrations/rules.ts`: `matchStatement(sql, dialect): StatementMatch[]` - pure, one statement in,
   zero or more matches out (an `ALTER TABLE` with several actions gives several). Contract:
   `StatementMatch = { rule: RuleId; class: FindingClass; table: SqlName | null; object: string; message: string }
   | { rule: 'identity-insert'; table: SqlName }` (a context marker, never a finding) and
   `{ rule: 'nested'; statements: string }` for an unwrapped `EXEC` literal or `DO` body that the caller splits and
   matches again (one level deep). `object` is `table` or `table.column` in display form. Messages say what an old
   build hits, for example `drop-column`: "old builds still read or write <t.c> and fail once it is gone; drop it in a
   release after the code stopped using it". The explicit-id rule reads the column list with `findClosingParen` and the
   `VALUES` tuples with `splitTopLevel`.
2. `src/layers/sql-migrations/classify.ts`: `classifyMigrations({ source, migrations, revision }): ClassifiedFinding[]`
   where `Migration = { id: string; path: string; statements: SqlStatement[] }` (lines already absolute in `path`)
   and `ClassifiedFinding = { finding: Finding; migration: string; object: string }`. It walks statements in order per Key decisions "Tables created" and "Redefined objects" (base `CREATE TABLE` names
   come in as `baseTables`), walks statements in order per migration (resetting the `IDENTITY_INSERT` set per migration), expands
   `nested` matches, downgrades findings on created tables to `safe`, merges explicit-id findings per (migration, table), and builds findings with `layer:
   'sql-migrations'`, `scope: source.name`, `subject: '<migration>: <object>'` and one revision `Evidence` with the
   statement line. `applyAccept(classified, accept)` → `{ findings, usage }` as in Key decisions.

**Tests:** rules, table-driven per dialect, one case per rule id in the Rules table, plus: EF Npgsql shapes
(`ALTER TABLE "Pets" ADD "Note" text;` safe, `ADD "Rank" integer NOT NULL DEFAULT 0;` safe,
`ALTER TABLE "Pets" ALTER COLUMN "Name" SET NOT NULL;` breaking); EF SqlServer shapes
(`ALTER TABLE [Pets] ADD [Rank] int NOT NULL DEFAULT 0;` safe, `EXEC sp_rename N'[Pets].[Url]', N'Address', N'COLUMN';`
rename-column, `EXEC sp_rename N'[PK_Pets]', N'PK_Animals';` silent, `IF SCHEMA_ID(N'system') IS NULL EXEC(N'CREATE
SCHEMA [system];');` nested, `ALTER TABLE [X] WITH CHECK ADD CONSTRAINT ... FOREIGN KEY` add-constraint,
`ALTER TABLE [X] ADD [a] int NULL, [b] int NOT NULL;` two matches; `ADD DEFAULT N'' FOR [c]` and
`ADD CONSTRAINT [DF_x] DEFAULT 0 FOR [c]` silent; `sp_rename N'[T].[MyIndex]', N'X', N'INDEX'` silent; a multi-line
`EXEC(N'INSERT ... VALUES (418, N''X'')')` nested); multi-action Postgres `ALTER TABLE`;
`DROP TABLE a, b`; `RENAME CONSTRAINT` silent; `CREATE VIEW` and `SELECT 1` silent; explicit-id insert with numeric
ids (range in the message), with uuid ids, and an insert without an id column (silent). classify: created-table
downgrade (unique index and foreign key on a new table are `safe`, on an existing one `needs-action`); drop and
recreate of an existing table stays `breaking`; `CREATE TABLE IF NOT EXISTS` of a base table downgrades nothing; a new
table renamed then indexed is `safe`; `DROP VIEW v` + `CREATE VIEW v` is `object-redefined`; three single-row inserts
with ids 1, 2, 3 give one finding with `1-3`; EF Npgsql `IF NOT EXISTS(...) THEN CREATE SCHEMA s; END IF` gives
`create-schema`; T-SQL `IF EXISTS (...) SET IDENTITY_INSERT [T] ON`;
`IDENTITY_INSERT` marks the following insert only within the same migration; nested `EXEC` evidence line; drizzle
`DO $$ BEGIN ALTER TABLE ... ADD CONSTRAINT ... EXCEPTION ... END $$;` matched; accept by id + migration, with and
without `object`, unused entry reported; an accepted finding keeps its class.

**Done when:**
- Automated: every rule id in the Rules table has a passing test in at least one dialect, and the dialect-specific
  ones in theirs.
- Automated: the named classify tests pass, including the created-table downgrade and the accept allowlist.
- Automated: Gates green (typecheck, lint, test).

## Phase 3: Sources, the layer and the F4/F5 acceptance cases
**Discipline:** TDD. **Files:** `src/layers/sql-migrations/config.ts`, `src/layers/sql-migrations/ef-script.ts`,
`src/layers/sql-migrations/sources.ts`, `src/layers/sql-migrations/sql-migrations-layer.ts`,
`src/layers/registry.ts`, `test/layers/sql-migrations/**`, `test/e2e/sql-migrations.test.ts`,
`test/fixtures/sql-migrations/**`

1. `src/layers/sql-migrations/config.ts`: the schema from Key decisions; `path` is relative without `..` and
   normalised per Key decisions; `include`
   globs are relative without `..`; `accept[].migration` non-empty.
2. `src/layers/sql-migrations/ef-script.ts`: `parseEfScript(text, dialect, historyTable): Result<EfMigration[]>` with
   `EfMigration = { id; statements: SqlStatement[] }` in script order, per Critical details; text without any guard
   (after trimming) → error naming the expected guard; an empty text → `[]`.
3. `src/layers/sql-migrations/sources.ts`: `readSourceChanges({ source, base, revision }): Result<SourceChanges>` with
   `SourceChanges = { newMigrations: Migration[]; changed: { kind: 'modified' | 'removed'; migration: string; path:
   string; side: Side }[] }`, per Key decisions (new, edited, removed, fail closed). Folder files are listed with
   `listFiles(include.map(glob => path + '/' + glob))`.
4. `src/layers/sql-migrations/sql-migrations-layer.ts`: `sqlMigrationsLayer` - per source: read changes, classify,
   add `migration-modified` / `migration-removed` findings (evidence at the side where the file still exists), apply
   accept; one source failing does not stop the others; errors → `failed` with the findings made so far, as in
   `openapi`. Notes: per source the number of new migrations and statements read, accept usage. Register it in
   `src/layers/registry.ts` after `openapiLayer` (one line).
5. Fixtures in the EF Core 8 `migrations script --idempotent` shape (noted in a leading comment):
   `test/fixtures/sql-migrations/ef-postgres/{base,revision-f4,revision}.sql` (EF Npgsql format, one `INSERT` per
   seeded row, `EnsureSchema` as `IF NOT EXISTS(...) THEN CREATE SCHEMA`: base with an `Init`
   migration creating `"Breeds"`; revision adds F4 (`CREATE SCHEMA system`, `system."FeatureFlags"`,
   `notifications."NotificationBroadcasts"` with an index, a unique index and a foreign key) and F5 (79 breeds with
   `"Id"` 418-496)); `ef-sqlserver/{base,revision-f4,revision}.sql` (the same migrations in EF SqlServer format with multi-line
   guards, `GO`, `IF SCHEMA_ID(...) IS NULL EXEC(N'CREATE SCHEMA ...')` and `IF EXISTS (...) SET IDENTITY_INSERT`;
   `revision-f4.sql` holds only the F4 migration); drizzle folder content built inline in the test.

**Tests:** config (each kind; unknown kind; duplicate names; `..` path; `db/` and `.` normalised; nested typo; empty `sources`); ef-script
(both dialects: ids in order, a migration spread over several blocks gathered, one-line and multi-line guards,
a custom `historyTable`, bookkeeping skipped, lines match the
fixture, no guard → error, empty → `[]`); sources in a temp repo (folder: new, modified, removed, nothing matches at
the revision → error; EF: absent at base → all new, absent at revision → error, removed id); layer (two sources, one
failing → `failed` with the other's findings). End to end through `main` on a temp repo per fixture: F4 alone
(revision with only the F4 migration) → layer verdict `safe`, exit 0; F4 + F5 → one `needs-action`
`insert-explicit-id` on `Breeds` whose message contains `418`, `496` and `max(Id)`, exit 0 with the default
`--fail-on breaking` and exit 1 with `--fail-on needs-action`; a drizzle folder adding a `DROP COLUMN` → `breaking`,
exit 1, evidence `drizzle/0002_x.sql:<line>`; the same with an accept entry → exit 0, listed as accepted.

**Done when:**
- Automated: the named config, ef-script, sources and layer tests pass.
- Automated: end to end, F4 gives the `sql-migrations` verdict `safe` and exit 0, in both dialects.
- Automated: end to end, F5 gives one `needs-action` `insert-explicit-id` naming 418, 496 and `max(Id)`, in both
  dialects, and exit 1 with `--fail-on needs-action`.
- Automated: end to end, a drizzle `DROP COLUMN` exits 1 with `path:line` evidence, and 0 once accepted.
- Automated: Gates green (typecheck, lint, test).

## Risks and rollback
- A rule misreads a statement (false `breaking`) → the accept allowlist records the reviewed case; the rule is fixed
  in a follow-up. A missed statement stays silent, which the roadmap accepts as the lesser risk for regex rules.
- A newer EF version changes the guard text → the layer fails with "no guard found" instead of passing; the guard
  regex is one place to update.
- The `runProcess` encoding option and the `readFile` change touch the core every layer uses → covered by the existing
  ref-tree tests plus the new encoding tests; default behaviour of `runProcess` is unchanged.
- Rollback: each phase is one commit on the change branch; reverting phase 3 removes the layer and its registry
  line; phases 1 and 2 add unused modules only. No data or schema changes.

## Decisions (auto)
- Complexity → medium (three phases; no split needed).
- Parser → own scanner plus rules, not `node-sql-parser` (one unknown construct must not fail a whole script).
- SQL Server `ALTER COLUMN` → `breaking` (cannot tell widening from narrowing; accept records reviewed cases).
- `DROP NOT NULL` → `rollback-risk` (the old build reads NULL into a required field only after the revision wrote one).
- `ALTER TYPE ... ADD VALUE` → `rollback-risk` (same reasoning as research F7).
- `DROP INDEX` / `DROP CONSTRAINT` → silent (they relax, old builds keep working).
- `safe` findings for additive statements → yes (the report shows what the release adds).
- Folder edits and removals of applied migrations → `needs-action` (production never runs the edit).
- Which column means "explicit id" → `id` only, not configurable in v1 (EF and drizzle convention; F5).
- Accept allowlist → yes, per source, mirroring `openapi`.
- UTF-16 decoding → in this change, through a `latin1` read in `RefTree` (core backlog item names CMP-2).
- Plan review findings C1, W1-W3, S1-S3 → all fixed in the plan (reviews/plan-review.md).

## Progress

> `- [ ]` pending, `- [x]` done. A phase ends with ` — <commit sha>` on its done items. Never rename items.

### Phase 1: Shared SQL scanner and UTF-16 decoding

#### Automated
- [x] 1.1 The named scanner and identifier tests pass — 86e292e
- [x] 1.2 `RefTree.readFile` returns the same text for UTF-8, UTF-8 with BOM, UTF-16LE and UTF-16BE (BOM) files — 86e292e
- [x] 1.3 Gates green (typecheck, lint, test) — 86e292e

### Phase 2: Statement rules and migration classification

#### Automated
- [ ] 2.1 Every rule id in the Rules table has a passing test in at least one dialect, and the dialect-specific ones in theirs
- [ ] 2.2 The named classify tests pass, including the created-table downgrade and the accept allowlist
- [ ] 2.3 Gates green (typecheck, lint, test)

### Phase 3: Sources, the layer and the F4/F5 acceptance cases

#### Automated
- [ ] 3.1 The named config, ef-script, sources and layer tests pass
- [ ] 3.2 End to end, F4 gives the `sql-migrations` verdict `safe` and exit 0, in both dialects
- [ ] 3.3 End to end, F5 gives one `needs-action` `insert-explicit-id` naming 418, 496 and `max(Id)`, in both dialects, and exit 1 with `--fail-on needs-action`
- [ ] 3.4 End to end, a drizzle `DROP COLUMN` exits 1 with `path:line` evidence, and 0 once accepted
- [ ] 3.5 Gates green (typecheck, lint, test)
