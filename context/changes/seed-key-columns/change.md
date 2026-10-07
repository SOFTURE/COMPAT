---
change_id: seed-key-columns
title: "A seed source can say which columns identify a row"
status: new
roadmap_item: CMP-16
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
A seed source accepts `keys: { "<table>": ["col", ...] }`; rows without a conflict target or `MERGE ... ON` pairs are keyed by those columns instead of the first column, so a changed row is reported as changed rather than as one removed and one added.

## Context
Roadmap v2 item CMP-16. Backlog seed-layer entry "row key falls back to the first column". Code: `src/layers/seed/`; starts after CMP-7 is merged (same file).

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- A configured key column missing from an insert fails that table's diff visibly.

## Notes
- 2026-10-07: opened from roadmap v2.
