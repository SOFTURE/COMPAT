---
change_id: openapi-serve-source
title: "openapi: a `serve` spec source that starts the app, waits for the spec URL and stops it"
status: archived
roadmap_item: issue #11
branch: claude/project-thread-kt16v8
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
An API whose spec exists only at runtime (ASP.NET with NSwag, Swashbuckle or FastEndpoints, spec hidden in
production) is checked without a hand-written wrapper script: the tool starts the app on a free port, fetches the
spec, and always stops the app and its children.

## Context
Dogfooding on PETSEO `2.2.4 -> 2.3.4` needed a ~20 line bash wrapper per API, with port collisions between the
parallel sides, a `401` behind an internal API key, diagnostics that hid the HTTP status, and orphaned processes
(issue #11). Base and revision are prepared in parallel since issue #12.

## Constraints
- A free port per side; `{port}` substituted in `run`, `url`, `ready`, `env` and header values.
- Header values support `${ENV}` and are never printed.
- A failure names the last HTTP status (or connection error) of the URL and the tail of the app output.
- No child process survives, also when it ignores SIGTERM.
- The background process helper is reusable (the behaviour layer, issue #22, builds on it).

## Notes
- Archived 2026-10-07: `serve` spec source, reusable background process helper (`src/process/background-process.ts`,
  `src/process/http-poll.ts`) for the behaviour layer (issue #22), `init` proposal for ASP.NET projects, README.
- The issue proposed `readyTimeoutSeconds` next to `timeoutSeconds`; one `timeoutSeconds` covers start-up until the
  spec is fetched, since the app stops right after (see plan.md decisions).
