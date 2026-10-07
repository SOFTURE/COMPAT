---
change_id: error-code-scoping
title: "error-codes: globs in accept and scoping codes to the operations that return them"
status: archived
roadmap_item: null
issue: 72
branch: issue-72
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
Cut the `error-code-unknown-to-client` noise of a real release (34 findings, 32 noise). `accept[].code` takes a glob
(`Shop.*`), and a new `returnedBy` config ties codes to the operations that return them: a code whose operations a
client's live refs do not call, or call only as `endpoint-added`, is `safe` for that client.

## Context
GitHub issue #72. `Shop.*` codes came only from `/api/shop/*` endpoints added in the same release,
`NotificationBroadcast.*` only from new admin endpoints, `ServiceVendor.Location.*` only from B2B endpoints that `web`
calls and `mobile` does not. `client-usage` already reads what each live client ref calls; `openapi` reports
`endpoint-added`; the `dependencies` layer already matches names with `globToRegExp`.

## Constraints
- Fail closed: a code no `returnedBy` entry covers, or a client without `client-usage` calls, keeps its finding.
- Keep the diff small; issue #68 changes the `codes` config of the same layer in parallel.
- English in everything committed.

## Notes
- 2026-10-07: opened from issue #72.
- 2026-10-07: implemented on branch issue-72; gates green (typecheck, lint, tests); archived.
