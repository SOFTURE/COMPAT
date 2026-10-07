---
change_id: dependency-lockfiles
title: "The dependencies layer compares resolved versions from lockfiles, including transitive ones"
status: new
roadmap_item: CMP-11
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
When a lockfile sits next to a manifest (`packages.lock.json`, `package-lock.json`, `pnpm-lock.yaml`), the `dependencies` layer compares the resolved versions of configured packages instead of the lower bound of ranges and reports transitive changes; without a lockfile it behaves as today.

## Context
Roadmap v2 item CMP-11. Backlog dependencies-layer entry. Code: `src/layers/dependencies/` (new lockfile readers; `read-nuget.ts` belongs to CMP-12).

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- Only configured packages are read from large lockfiles.
- pnpm lockfile v6 and v9 are both supported or the unsupported one fails visibly.

## Notes
- 2026-10-07: opened from roadmap v2.
