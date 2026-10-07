---
change_id: sql-migrations-layer
title: "Migrations new in the revision are classified for Postgres and SQL Server, with evidence per statement"
status: new
roadmap_item: CMP-2
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
`softure-compat check` gets a `sql-migrations` layer. It takes only the migrations that exist in the revision and not
in the base, splits them into statements and classifies each one, so the owner sees which schema or data changes an
older server build (still running, or rolled back to) cannot live with.

## Context
Roadmap item CMP-2 (`context/foundation/roadmap.md`). Design input: research §4 layer 3 and §3 (SQL Server is a
first-class dialect; Squawk covers only Postgres) in `../../archive/2026-10-07-backward-compat-checker/research.md`.
Acceptance fixtures: F4 (only new schema/tables → `safe`) and F5 (insert with explicit IDs 418–496 →
`needs-action` with the precondition that production `max(Id)` is below the first inserted id).

Expected rule set (refine in research/plan): drop table or column, rename (Postgres `RENAME`, SQL Server
`sp_rename`), column type change, `SET NOT NULL` / `NOT NULL` on an existing column, a new `NOT NULL` column without a
default → `breaking`; new unique index or constraint, `UPDATE`/`DELETE` data migrations, inserts with explicit ids
(including `IDENTITY_INSERT ON`) → `needs-action`; `TRUNCATE` → `breaking`; new schema, table, nullable column or
index → `safe`. Unrecognised statements stay silent.

Sources to support: a folder of plain SQL scripts (drizzle folders with `--> statement-breakpoint`, any
`*.sql` folder) and an EF Core idempotent script (`migrations.sql`), where migration ids sit in the
`__EFMigrationsHistory` guards of each block for both dialects.

## Constraints
- Builds on the core of CMP-1 (`Layer` interface, `RefTree`, finding model, config schema). Starts after CMP-1 is merged.
- Owns `src/layers/sql-migrations/` and a shared SQL statement splitter that CMP-3 reuses (strings, comments,
  Postgres dollar quoting, SQL Server `GO` batches). Touches the layer registry and the config schema with one entry each.
- No external linter in v1 (Squawk stays in `context/backlog/later-layers.md`); no database connection.
- English in everything committed (AGENTS.md).

## Notes
- 2026-10-07: opened from roadmap v1.
