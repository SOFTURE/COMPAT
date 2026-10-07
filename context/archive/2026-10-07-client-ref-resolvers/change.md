---
change_id: client-ref-resolvers
title: "client-usage refs accept ref resolvers and resolve live client builds from workflow runs"
status: archived
roadmap_item: null
issue: 41
branch: claude/project-thread-llwmwh
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
`client-usage.clients[].refs` accepts every `--base` resolver (`github-deployment:<env>`, `github-workflow:<file>`,
`latest-tag[:glob]`) next to literal refs, and a new multi-ref selector `{ "workflowRuns": "<file>", "since"? }`
that resolves to the head commits of all successful runs of a workflow, at or above a version or since a date.
The layer notes name what each resolver resolved to.

## Context
GitHub issue #41 (PETSEO: web clients ship with the server, mobile builds come from `eas-prod.yml` runs on tags
interleaved with server tags). Base-ref resolvers come from #21. Issue #48 (`error-codes`) will read client
translation maps at the same live client refs, so the ref-list schema and resolver live in `src/resolve/`, not in
the client-usage layer.

## Constraints
- A resolver that finds nothing fails the layer; never a guess (same rule as #21).
- Existing configs (`[refs]`, `{ tags, since }`) keep working unchanged.
- English in everything committed.

## Notes
- 2026-10-07: opened from issue #41.
- 2026-10-07: implemented on branch claude/project-thread-llwmwh; gates green (typecheck, lint, 902 tests, test:pack); archived.
