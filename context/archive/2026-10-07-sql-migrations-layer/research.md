# Research: sql-migrations-layer

Input: change.md, roadmap CMP-2, archived research of `backward-compat-checker`. Depth: normal.
Snapshot: ef1589e on claude/project-thread-62yuez (CMP-1, PR #2, not merged yet), 2026-10-07 11:10 Europe/Warsaw.

## Summary
The core from CMP-1 already gives everything a layer needs: `defineLayer` with a strict zod schema, a `RefTree` per
side with `listFiles(globs)` and `readFile(path)`, the finding model and the registry. The new layer needs three
own pieces: a dialect-aware SQL scanner (statements, comments, strings, dollar quotes, `GO` batches) shared with
CMP-3, a reader that turns each source into a list of migrations with statements and line numbers (a folder of
`.sql` files, or an EF Core idempotent script segmented by its `__EFMigrationsHistory` guards), and a pure rule set
that classifies one statement. The only core gap is text decoding: `RefTree.readFile` decodes UTF-8 only, and SQL
Server scripts saved by SSMS or Visual Studio are often UTF-16 with a BOM (backlog `context/backlog/core.md`).
No database connection and no external linter (change Constraints).

## Current state
- `src/layers/layer.ts:20-34`: `Layer` = `{ name, description, configSchema (z.ZodObject), run(context) }`;
  `defineLayer` erases the config type for the registry.
- `src/layers/registry.ts:5`: `LAYERS = [openapiLayer]`; one line per layer. `src/config/config.ts:13-24` composes
  `{ layers: { <name>: schema.extend({ enabled }) } }` from the registry, so a new layer adds no config code.
- `src/git/ref-tree.ts:14-23`: `listFiles(globs)` filters one cached `git ls-tree` listing with `src/git/glob.ts`
  (`**`, `*`, `?`, `{a,b}`); `readFile(path)` returns `string | null` and strips a UTF-8 BOM
  (`src/git/ref-tree.ts:104-109`). `runProcess` decodes stdout as UTF-8 (`src/process/run-process.ts:76`), so a
  UTF-16 file arrives already damaged (invalid sequences become U+FFFD).
- `src/model/finding.ts:14-34`: `Finding = { layer, scope, id, subject, class, message, evidence[], accepted? }`;
  `LayerResult` `failed` keeps findings and notes for the gate.
- `src/layers/openapi/classify.ts`: the accept allowlist pattern (`applyAccept` returning `findings` and per-entry
  `usage`, notes for unused entries) that this layer mirrors for reviewed false positives.

## Affected surface
| Area | Files | Why |
| --- | --- | --- |
| Shared SQL scanner | `src/sql/statements.ts` (new), `src/sql/identifiers.ts` (new) | splitter and name parsing that CMP-3 reuses |
| Layer | `src/layers/sql-migrations/*` (new) | config, sources, EF script reader, rules, classification, layer |
| Registry | `src/layers/registry.ts` | one line |
| Text decoding | `src/git/ref-tree.ts`, `src/process/run-process.ts` | decode UTF-16 (BOM) scripts losslessly |
| Tests | `test/sql/**`, `test/layers/sql-migrations/**`, `test/e2e/sql-migrations.test.ts`, `test/fixtures/sql-migrations/**` | |
| Backlog | `context/backlog/core.md` | close the UTF-16 item |

## Data
None in this repository. The layer reads migration scripts of the consumer; it never connects to a database.

## Tests
Vitest, `npm test`. Temp git repositories through `test/helpers/git-repo.ts` (`createRepo` with files per commit and
tags); end-to-end through `main()` with `createIo` (`test/e2e/openapi.test.ts` is the pattern). No fixture for SQL yet.

## Patterns to follow
- Layer folder with `config.ts` (strict zod), pure classification module, `<name>-layer.ts` that collects errors per
  scope and returns `failed` with the findings made so far (`src/layers/openapi/openapi-layer.ts:41-62`).
- Relative-path schema without `..` and absolute paths (`src/layers/openapi/config.ts:5-9`).
- Expected failures as `Result` values (`src/result.ts`).

## Prior work
- `context/archive/2026-10-07-backward-compat-checker/research.md` §1 (F4, F5), §3 (SQL Server is first class,
  Squawk is Postgres only), §4 layer 3.
- `context/backlog/core.md`: UTF-16 decoding left for this change.
- `context/backlog/later-layers.md`: Squawk stays a later optional pass.

## SOFTURE modules
Not applicable: no `@softure-ai/*` module parses SQL, and AGENTS.md forbids depending on other `@softure-ai/*`
packages.

## Risks
- Regex rules miss exotic DDL (likely). Mitigation: an unrecognised statement stays silent, never `breaking`; the
  rule list is table-tested per dialect.
- EF idempotent scripts change shape between EF versions (possible). Mitigation: the reader matches the guard, not the
  surrounding `DO`/`GO` layout, and a script with no guard fails the layer instead of passing it.
- A rule cannot see the base schema (certain). SQL Server `ALTER COLUMN` repeats the whole column definition, so a
  widening and a narrowing look the same. Mitigation: classify conservatively and let the accept allowlist record a
  reviewed change.
- Statements on a table created by the same set of new migrations (EF emits indexes and foreign keys for every new
  table) would read as `needs-action`. Mitigation: a pre-pass collects created tables and downgrades their findings to
  `safe`; required for F4.

## Relevant lessons
None (`context/foundation/lessons.md` does not exist).

## Answers to unknowns
- **How EF idempotent scripts mark migration ids** (roadmap CMP-2 unknown), from the EF Core migration SQL generators
  (EF Core 6-9, Npgsql and SqlServer providers):
  - Npgsql: every operation is its own block
    `DO $EF$ BEGIN IF NOT EXISTS(SELECT 1 FROM "__EFMigrationsHistory" WHERE "MigrationId" = '<id>') THEN <sql>; END IF; END $EF$;`,
    the last block of a migration inserts into `"__EFMigrationsHistory"`. The script also holds an unguarded
    `CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory"`, `START TRANSACTION;` and `COMMIT;`.
  - SqlServer: every operation is a block
    `IF NOT EXISTS (SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'<id>') BEGIN <sql>; END;`,
    usually followed by `GO`. Statements that must start a batch are wrapped as `EXEC(N'...')` (for example
    `IF SCHEMA_ID(N'system') IS NULL EXEC(N'CREATE SCHEMA [system];');` and filtered indexes); seed data uses
    `SET IDENTITY_INSERT [T] ON;` around the insert; a dropped column first drops its default constraint through a
    `DECLARE @var sysname` block.
  - So a migration is the ordered set of guarded blocks with the same id; anything outside a guard is EF bookkeeping.
- **Drizzle folders**: one `NNNN_name.sql` per migration, statements separated by `--> statement-breakpoint` (a line
  comment) after the `;`; enums and foreign keys are wrapped in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN
  null; END $$;`, so the body of a `DO` block must be classified too.
- **Which migrations are new**: folder sources by path (present in the revision, absent in the base); EF scripts by
  migration id. A folder migration that exists at both refs with different content, or that disappeared, was already
  applied in production and is reported, not re-classified.
