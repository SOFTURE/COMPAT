---
change_id: dependency-lockfiles
title: "The dependencies layer compares resolved versions from lockfiles"
status: new
roadmap_item: CMP-10
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
When a lockfile sits next to a manifest (`package-lock.json`, `pnpm-lock.yaml`, NuGet `packages.lock.json`), the `dependencies` layer compares the resolved versions of direct dependencies instead of the lower bound of their ranges, and reports transitive changes of packages listed in `watch`; without a lockfile it behaves as today.

## Context
Roadmap v2 item CMP-10. Backlog dependencies-layer entry. Today a range compares by its lower bound (README `dependencies`), so `npm update` that moves `^4.1.0` from 4.1.0 to 4.9.0 in the lockfile only, or a watched messaging client upgraded transitively, produces no finding although the running code changed. Code: `src/layers/dependencies/` (new lockfile readers).

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- Only direct dependencies and `watch` packages are read from large lockfiles.
- pnpm lockfile v6 and v9 are both supported, or the unsupported one fails visibly.

## Notes
- 2026-10-07: opened from roadmap v2.
