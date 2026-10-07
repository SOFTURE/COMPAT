---
change_id: seed-statement-coverage
title: "Seed writes inside CTEs and dynamic SQL are diffed, and unreadable bulk loads are reported instead of staying silent"
status: new
roadmap_item: CMP-7
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
The `seed` layer reads CTE writes (`WITH ... INSERT/UPDATE/DELETE`) row by row like plain writes, unwraps dynamic SQL with a literal body (`EXEC(N'...')`, `EXEC sp_executesql N'...'`, `EXECUTE '...'` in a `DO` body) and reads the inner statements, and reports `EXECUTE format(...)`, `COPY` and `BULK INSERT` as `unreadable-write` `needs-action`.

## Context
Roadmap v2 item CMP-7. Backlog entries in `context/backlog/later-layers.md`: dynamic SQL, `COPY` and `BULK INSERT` stay silent; CTE writes are reported as `unreadable-write` (seed-layer impl review W3). Code: `src/layers/seed/seed-statements.ts`, shared scanner in `src/sql/`.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- Owns `src/layers/seed/seed-statements.ts` until merged; CMP-16 waits for it.
- Evidence keeps the line numbers of the outer file after unwrapping.
- Postgres and SQL Server dialects.

## Notes
- 2026-10-07: opened from roadmap v2.
