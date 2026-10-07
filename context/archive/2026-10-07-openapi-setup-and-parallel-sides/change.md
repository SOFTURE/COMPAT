---
change_id: openapi-setup-and-parallel-sides
title: "openapi: a per-side setup command shared by all APIs, and base and revision prepared in parallel"
status: archived
roadmap_item: issue #12
branch: claude/project-thread-iht6r1
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
Several APIs built from one solution cost one build per side, not one build per API per side, and the two sides
no longer wait for each other.

## Context
PETSEO has 3 HTTP APIs in one .NET solution; the openapi layer took 3 min 18 s for `2.2.4 -> 2.3.4`, almost all
of it in 6 sequential build and run cycles (issue #12).

## Constraints
- Same environment for `setup` as for `command` sources (`COMPAT_SIDE`, `COMPAT_REF`, `COMPAT_COMMIT`).
- A failing setup fails the layer and names the side and ref.
- `concurrency: 1` keeps the sides sequential.

## Notes
- Archived 2026-10-07: `setup` and `concurrency` added to the openapi config, README updated.
