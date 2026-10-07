---
change_id: squawk-postgres-pass
title: "New Postgres migrations can also be linted by Squawk, downloaded pinned and verified"
status: new
roadmap_item: CMP-8
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
A Postgres `sql-migrations` source with `squawk: true` (or `{ exclude: [rule...] }`) runs Squawk over the new migrations and adds its findings as `squawk:<rule>` with a class per rule. Own rules stay authoritative; a Squawk finding on the same statement and object as an own finding is dropped. Squawk is downloaded pinned with SHA-256 checksums per OS and arch into the user cache; `--no-download` or a missing binary makes the pass `skipped`, never `safe`.

## Context
Roadmap v2 item CMP-8. Backlog entry: optional Squawk pass once its JSON output can be verified in CI. The oasdiff download (`src/layers/openapi/oasdiff-download.ts`, issue #13) is the pattern; this change extracts it into a shared pinned-binary helper that CMP-17 (`buf`) reuses.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- Squawk's JSON output is parsed with a zod schema; an unknown shape fails the pass.
- CI runs the real pinned Squawk in at least one test.
- The shared helper keeps oasdiff behaviour and its tests unchanged.

## Notes
- 2026-10-07: opened from roadmap v2.
