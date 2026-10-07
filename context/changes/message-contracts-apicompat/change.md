---
change_id: message-contracts-apicompat
title: "Message contracts can be compared precisely with ApiCompat on built assemblies"
status: new
roadmap_item: CMP-13
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
A `message-contracts` source may set `mode: "apicompat"` with a `build` command and the assembly paths; the layer builds both refs in temporary worktrees, runs Microsoft.DotNet.ApiCompat and maps its diagnostics to findings, which also covers base types declared outside the sources. Without `dotnet` the source is `skipped`.

## Context
Roadmap v2 item CMP-13. Backlog message-contracts entry; `context/archive/2026-10-07-message-contracts-layer/plan.md`. Code: `src/layers/message-contracts/`; process helpers in `src/process/`.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- The source-level parser stays the default mode.
- Temporary worktrees are always removed.
- CI installs a .NET SDK for the acceptance test; locally the test skips with a visible reason.

## Notes
- 2026-10-07: opened from roadmap v2.
