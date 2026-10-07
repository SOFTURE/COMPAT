---
change_id: base-ref-resolvers
title: "--base and --revision accept resolvers: github-deployment:, github-workflow:, latest-tag"
status: archived
roadmap_item: issue #21
branch: claude/project-thread-f9q8j0
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
`--base` must be the ref running in production, and people pick the wrong one (the newest tag is usually DEV, not
production). Let `--base` and `--revision` take a resolver that asks GitHub (or git) what production runs, so CI does
not script the lookup and a wrong base never silently compares the wrong pair.

## Context
GitHub issue #21. `commands/check.ts` passes the ref to `openRefTree` verbatim. On PETSEO production was found with
`gh run list -w deploy-prod.yml` (`2.2.4`) while DEV ran `2.3.4`.

## Constraints
- Never guess: an unresolvable resolver is exit code 2 with a message saying what to fix.
- The resolved commit must exist locally; the error says to fetch it (`fetch-depth: 0`).
- The report header shows the resolver and what it resolved to.
- No new runtime dependency; the GitHub API is called with `fetch`, responses narrowed with zod.
- English in everything committed.

## Notes
- Archived 2026-10-07: `src/resolve/` (ref-spec, GitHub client, resolveRefSpec), `check.ts` opens resolved commits,
  report header and JSON carry `resolver`, README "Finding the production ref". Impl review: a `latest-tag` glob
  that starts with `-` would be read as a git option; accepted, git rejects `--` before the pattern in `git tag --list`.
