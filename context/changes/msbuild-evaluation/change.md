---
change_id: msbuild-evaluation
title: "MSBuild properties and conditions are evaluated before package versions are compared"
status: new
roadmap_item: CMP-12
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
`$(Property)` resolves through `Directory.Build.props`, `Directory.Packages.props` and explicit `<Import>`s up the folder chain; `Condition` attributes with simple comparisons (`==`, `!=`, `and`, `or`, `Exists` treated as unknown) are evaluated per configured property set; an expression that cannot be evaluated stays `dependency-changed` with the reason.

## Context
Roadmap v2 item CMP-12. Backlog dependencies-layer entry. Code: `src/layers/dependencies/read-nuget.ts`.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- A documented subset of MSBuild; anything else fails visible, never silently true.
- Owns `read-nuget.ts`; CMP-11 adds new files next to it.

## Notes
- 2026-10-07: opened from roadmap v2.
