---
change_id: seed-layer
title: "Seed scripts that run on every deploy are diffed and their effect on existing rows is classified"
status: new
roadmap_item: CMP-3
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
`softure-compat check` gets a `seed` layer for scripts that run on every deploy (PETSEO `seed.sql`). New upserted rows
are `safe`; statements that overwrite or delete existing rows, or inserts without a conflict guard, are
`needs-action`, each with evidence.

## Context
Roadmap item CMP-3. Design input: research §4 layer 4. Acceptance fixture: F6 (3 new `TermsChange` templates with
`ON CONFLICT DO UPDATE`, nothing updated or deleted → `safe`).

Expected behaviour (refine in research/plan): diff the configured seed files between the refs statement by
statement; for multi-row `INSERT ... VALUES`, compare tuples so that added rows are `safe`, a changed row under
`ON CONFLICT DO UPDATE` / `MERGE ... WHEN MATCHED` is `needs-action`, and a row that is no longer seeded is reported
as `safe` information (the row stays in the database). Added `UPDATE`, `DELETE`, `TRUNCATE` → `needs-action`.

## Constraints
- Builds on CMP-1 and reuses the SQL statement splitter from CMP-2; starts after CMP-2 is merged.
- Owns `src/layers/seed/`. Touches the layer registry and the config schema with one entry each.
- Postgres and SQL Server dialects. English in everything committed.

## Notes
- 2026-10-07: opened from roadmap v1.
