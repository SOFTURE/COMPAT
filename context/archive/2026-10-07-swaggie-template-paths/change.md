---
change_id: swaggie-template-paths
title: "client-usage reads swaggie paths with nested template literals and fails closed on unread URLs"
status: archived
roadmap_item: null
issue: 40
branch: claude/project-thread-tc77zq
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
The TypeScript client reader reads every template hole as a path parameter, nested template literals included
(swaggie: `` `/api/pets/${encodeURIComponent(`${petId}`)}/medications` ``). When a URL string still cannot be read,
the `client-usage` layer fails instead of counting the missing operations as "not called".

## Context
GitHub issue #40. On PETSEO `2.2.4 → 2.3.5` the reader returned 28 of 86 operations of the swaggie axios client:
the tokenizer ended the template literal at the first nested backtick, so every parameterised path was dropped and
`POST /api/pets/{petId}/medications` was re-classified to `safe` as "not called". Same failure mode as #14 (F2).

## Constraints
- A reader miss must never read as "not called": fail closed.
- The tokenizer is shared with `persisted-enums`, `message-contracts` (C# only) and enum branch detection.
- English in everything committed.

## Notes
- 2026-10-07: opened from issue #40; reproduced (the nested-backtick path is dropped, `` `/api/y/${id}` `` is read).
- 2026-10-07: implemented and archived; gates green (typecheck, lint, test, build, test:pack).
