---
change_id: live-client-refs
title: "client-usage learns which client builds are live from Sentry releases or a command"
status: new
roadmap_item: CMP-9
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
`clients[].refs` accepts `{ sentry: { org, project, environment?, days?, tag } }` (releases seen in the last `days`, default 30, mapped to git tags by a template such as `mobile-{version}`) and `{ command, tag }` (a command printing one version per line). The token comes from `SENTRY_AUTH_TOKEN` and is never logged. A source that returns no version, or a version without a matching tag in the clone, fails the layer (fail closed).

## Context
Roadmap v2 item CMP-9. Research §6 question 6 and the backlog entry "read live client versions from store or Sentry release data". Code: `src/layers/client-usage/client-refs.ts`. The GitHub resolvers in `src/resolve/` show the HTTP and token pattern.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- Tests use a local fake HTTP server, no real Sentry calls.
- Store APIs (App Store, Google Play) are out of scope; the `command` source covers them.
- `SENTRY_URL` overrides the API base for self-hosted Sentry.

## Notes
- 2026-10-07: opened from roadmap v2.
