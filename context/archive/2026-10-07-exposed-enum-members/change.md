---
change_id: exposed-enum-members
title: "Added members of enums that reach clients as plain strings are reported, and refined by client-usage"
status: archived
roadmap_item: null
issue: 15
branch: claude/project-thread-snh1ty
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
A `persisted-enums` named entry may declare `exposed: [{ api, fields }]`: the DTO fields through which the enum
reaches clients as a plain string. An added member of such an enum gets an extra `enum-member-exposed-added` finding
(`needs-action`: old clients receive an unknown value in that field). When `client-usage` has clients for that API,
it re-classifies the finding: no live client ref branches on the field (switch, comparison, lookup map) → `safe`
with evidence; one does → the class stays and the branch sites become evidence.

## Context
GitHub issue #15. PETSEO `2.3.4` adds `NotificationType.TermsChange`, returned in `NotificationDto.type`, which the
exported spec types as `string`, so oasdiff reports nothing. Builds on the refinement contract of #14 (PR #34).

## Constraints
- Reuse the #14 refinement contract (`LayerContext.results`, `revisions`); no new core mechanism.
- A scanner miss must never read as "does not branch" (lesson from CMP-4 and #16): token detection plus a raw-text
  safety net over the client sources, comments excluded; anything doubtful counts as a branch.
- English in everything committed. Shared files with #22 running in parallel: merge master before merging.

## Notes
- 2026-10-07: opened from issue #15.
- 2026-10-07: implemented on branch claude/project-thread-snh1ty; gates green (typecheck, lint, 828 tests, test:pack); archived.
