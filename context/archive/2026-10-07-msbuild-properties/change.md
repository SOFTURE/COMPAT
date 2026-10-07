---
change_id: msbuild-properties
title: "Package versions held in MSBuild properties of imported props files are compared"
status: archived
roadmap_item: CMP-9
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
`$(Property)` in a package version resolves through the `Directory.Build.props` chain up the folder tree and explicit `<Import Project="...">` of files in the repository, nearest definition winning as in MSBuild; a property that still cannot be resolved stays `dependency-changed` with the reason.

## Context
Roadmap v2 item CMP-9. Backlog dependencies-layer entry. Checked on 2026-10-07: `expandProperties` in `src/layers/dependencies/read-nuget.ts` resolves only the declaring file, so the common .NET pattern `Version="$(MassTransitVersion)"` with the value in `Directory.Build.props` reads as the same unresolved text at both refs, and upgrading the property produces no finding at all. `Condition` evaluation was rejected in roadmap v2: several versions of one package already compare conservatively.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- Owns `read-nuget.ts`; CMP-10 adds new files next to it.
- Imports outside the repository or with property-based paths fail visibly, never silently resolve.

## Notes
- 2026-10-07: opened from roadmap v2.
- Archived 2026-10-07: NuGet `$(Property)` versions resolve through the nearest Directory.Build.props, Directory.Packages.props, in-repository imports and Directory.Build.targets; unresolved or condition-dependent ones stay `dependency-changed` with the reason.
