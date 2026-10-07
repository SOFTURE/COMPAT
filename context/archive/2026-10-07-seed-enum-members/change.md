---
change_id: seed-enum-members
title: "A seed row that writes a persisted-enum member new in the revision is rollback-risk"
status: done
roadmap_item: null
branch: issue-71
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
When `seed` and `persisted-enums` both run, a `row-added` or `row-changed` seed finding whose rows write a string
literal equal to a member that `persisted-enums` reports as `enum-member-added` (string storage) is `rollback-risk`,
with the enum declaration as evidence. The `enum-member-added` finding then says the seed writes the member on
deploy, with the seed row as evidence.

## Context
GitHub issue #71. `seed` classified `row-added` as `safe` ("old builds ignore rows they do not know") while
`persisted-enums` reported the member the rows store as `rollback-risk`: after a rollback, the base build cannot read
the seeded rows at all.

## Constraints
- English in everything committed.
- Reuse the existing refinement mechanism (`FindingRevision`, as `client-usage` uses); no new config.
- A seed row whose literals match no added member stays as it was.

## Notes
- 2026-10-07: opened from issue #71; the optional `enumColumns` config was left out.
- 2026-10-07: implemented and archived.
