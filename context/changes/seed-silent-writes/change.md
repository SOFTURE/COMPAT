---
change_id: seed-silent-writes
title: "Seed writes hidden in dynamic SQL or bulk loads are read or reported, never silent"
status: new
roadmap_item: CMP-7
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
Dynamic SQL with a literal body in a seed script (`EXEC(N'...')`, `EXEC sp_executesql N'...'`, `EXECUTE '...'` inside a `DO` body) is unwrapped and its statements are diffed like any other; dynamic SQL without a literal body (`EXECUTE format(...)`, string concatenation) and `COPY ... FROM` are reported as `unreadable-write` `needs-action`.

## Context
Roadmap v2 item CMP-7. Backlog seed-layer entry "dynamic SQL, `COPY` and `BULK INSERT` stay silent". Checked on 2026-10-07: `src/layers/seed/seed-statements.ts` decides a statement is a write by `WRITE_WORD` on the text with literals masked, so a write inside `EXEC(N'...')` and every `COPY` produce no finding: a seed that overwrites rows that way passes the gate as if nothing changed. `BULK INSERT` already reads as `unreadable-write` (it contains `INSERT`); this change only adds a test for it. CTE writes are already `unreadable-write` and stay so (row-level parsing was rejected in roadmap v2).

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- Evidence keeps the line numbers of the outer file after unwrapping.
- Unwrapping reuses the nesting limit of `DO` bodies.
- Postgres and SQL Server dialects.

## Notes
- 2026-10-07: opened from roadmap v2.
