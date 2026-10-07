---
change_id: release-readiness
title: "The package is ready for its first npm release: documented, initialised in one command, tested end to end in CI"
status: impl_reviewed
roadmap_item: CMP-6
branch: claude/project-thread-q44ui9
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
A SOFTURE project can adopt the tool from the README alone, `softure-compat init` writes a starter
`compat.config.json`, CI runs the gates with oasdiff installed, a publish workflow releases to npm with provenance
when the owner pushes a tag, and an end-to-end test on a synthetic repository reproduces every in-scope PETSEO
acceptance finding (F1, F2, F4, F5, F6, F7, F10) with its expected class.

## Context
Roadmap item CMP-6, the last item of roadmap v1. The owner publishes to npm with his own token; this change only
prepares the workflow and the package metadata (`publishConfig.access: public`, `provenance: true`, MIT).
README must document that `command` spec sources run inside both materialised refs, and how to install oasdiff.

## Constraints
- Starts after CMP-2, CMP-3, CMP-4 and CMP-5 are merged.
- Never publishes, tags or stores secrets; the `NPM_TOKEN` secret is the owner's.
- English in everything committed.

## Notes
- 2026-10-07: opened from roadmap v1.
