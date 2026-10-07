---
change_id: new-table-followup-message
title: "Safe follow-ups on a table created by the new migrations get a neutral message"
status: archived
roadmap_item: issue #23
branch: claude/project-thread-0ycwed
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
A finding downgraded to `safe` because its table is created by the same migrations no longer carries the
original rule's risk text ("old builds ... start failing", "precondition: ..."), so it does not contradict itself.

## Context
`classify.ts` prefixed the rule's own message with "on a table created by these migrations, so no old build uses
it:", also for merged explicit-id inserts. Reported on PETSEO `2.2.4 -> 2.3.4` (issue #23).

## Constraints
- Classes stay as they are; only the message of new-table follow-ups changes.
- English in everything committed.

## Notes
- Archived 2026-10-07: `NEW_TABLE_ACTIONS` in `src/layers/sql-migrations/classify.ts` gives each non-additive
  rule a neutral verb; the message reads "<action> <object>; the table is created by these migrations, so no old
  build uses it". Folding follow-ups into the `create-table` finding was left out (optional in the issue).
