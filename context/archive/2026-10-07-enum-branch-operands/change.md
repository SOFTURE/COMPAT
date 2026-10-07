---
change_id: enum-branch-operands
title: "client-usage ignores comparisons of a same-named property with strings that are not enum members"
status: archived
roadmap_item: null
issue: 69
branch: issue-69
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
The exposed-enum branch scan of `client-usage` counted any comparison whose operand ends in the property name as a
branch on the enum. With `NotificationDto.type`, `event.type === 'set'` (a picker event) and
`key.toLowerCase() === 'content-type'` (a string whose text ends in `type`) kept `enum-member-exposed-added` at
`needs-action`. A string literal is now never the property, and a comparison or `case` label against a string
literal that names no member of the enum is not a branch.

## Context
GitHub issue #69, a follow-up of #15 (`2026-10-07-exposed-enum-members`).

## Constraints
- Fail closed: identifiers, template literals with holes and anything the scanner cannot read still count.
- A finding without member values (older producers, hand-built findings) keeps the old behaviour.
- `refine.ts` changes in parallel (request property paths): keep the diff out of it.

## Notes
- 2026-10-07: opened from issue #69; the optional `branchFiles` idea is out of scope.
- 2026-10-07: implemented on branch issue-69; gates green (typecheck, lint, 1080 tests); archived.
