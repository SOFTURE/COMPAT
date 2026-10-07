---
change_id: init-openapi-serve-selection
title: "init: propose openapi serve sources only for executable projects that register a spec, with one shared build"
status: archived
roadmap_item: issue #44
branch: claude/project-thread-u1ba11
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
`init` proposes a `serve` source only for a project that can run and serve a spec, and several APIs from one
solution share one `dotnet build` per side instead of one build per API per side.

## Context
On PETSEO `init` proposed five `serve` sources: one was a class library (`dotnet run` fails), one never registers
a Swagger document (the layer times out), and the five `dotnet run` commands built the same solution ten times in
parallel (issue #44).

## Constraints
- Detection reads the committed files of HEAD only, as every other `init` detector.
- The layer stays disabled; the user reviews the sources before enabling it.
- Only `detectServedOpenapi` and its helpers change: parallel threads edit other `init.ts` detectors.

## Notes
- Archived 2026-10-07: `init` keeps only executable projects (Web SDK or `OutputType` Exe) with a spec registration
  call, names the ones left out, and writes a shared `dotnet build <solution>` setup with `--no-build` runs when
  one solution lists two or more APIs. README `openapi` section updated.
