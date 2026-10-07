---
change_id: automatic-release
title: "Releases are fully automatic: a version bump merged to master is published by the pipeline"
status: archived
roadmap_item: CMP-6 (follow-up)
branch: claude/project-thread-m9uyf4
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
Nobody runs `npm publish` or pushes a tag by hand. The first version is published by the pipeline with the
`NPM_TOKEN` secret the owner adds; later versions use npm trusted publishing (OIDC) with no change to the workflow.

## Context
CMP-6 left a tag-driven `release.yml` modelled on SOFTURE/skills that needed a manual first `npm publish` and a
manually pushed tag. The owner asked for the SOFTURE/skills pipeline without any manual step.

## Constraints
- Never publish or push a tag before the owner adds `NPM_TOKEN`; merging this change must not fail master.
- Keep the file name `release.yml` (the npm trusted publisher is bound to it).
- English in everything committed.

## Notes
- Archived 2026-10-07: `release.yml` releases every unreleased version pushed to master; README "Releasing" rewritten.
