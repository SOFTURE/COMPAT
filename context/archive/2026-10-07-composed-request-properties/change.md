---
change_id: composed-request-properties
title: "client-usage resolves request properties under allOf and reads intersection body types"
status: archived
roadmap_item: null
issue: 70
branch: issue-70
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
A request property finding whose path runs through an `allOf[subschema #N]` segment can be proven always sent
by the generated client, so the `client-usage` layer can drop it to `safe`.

## Context
GitHub issue #70. oasdiff reports ``the request property `allOf[subschema #2]/daysOfWeek` became not nullable``;
the property path looked up `allOf[subschema #2]` as a member of the body type, which never exists, so the finding
always read "may send it without".

## Constraints
- A miss must never turn a finding `safe`: `oneOf`/`anyOf` stay conservative.
- Keep the diff away from enum branch detection (changed in parallel).
- English in everything committed.

## Notes
- 2026-10-07: opened from issue #70; reproduced with a unit test.
- 2026-10-07: implemented and archived; gates green (typecheck, lint, test).
