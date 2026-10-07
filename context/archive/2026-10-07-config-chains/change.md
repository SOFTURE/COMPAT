---
change_id: config-chains
title: "A key present in one deploy source must be present in all of them"
status: archived
roadmap_item: null
issue: 19
branch: claude/project-thread-ara09s
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
Adding a configuration value is a chain of edits (compose, Ansible template, Ansible defaults, assert, deploy
workflows). The `config` layer compares each source between refs but never compares sources with each other, so a
key added to `deploy-dev` and not to `deploy-prod` passes. A `chains` section lists groups of sources where every key
present in one must be present in all the others, and reports `config-chain-missing` otherwise.

## Context
GitHub issue #19. Keys are matched with the identity from #18 (`src/layers/config/keys.ts`).
Issue #20 (`presence`) changes `config.ts`, `classify.ts` and `config-layer.ts` in parallel, so the chain logic
lives in its own module and those files change only where they must.

## Constraints
- Owns `src/layers/config/` only; no core, report or other layer change.
- English in everything committed.

## Notes
- 2026-10-07: opened from issue #19 on branch claude/project-thread-ara09s.
- 2026-10-07: implemented and archived on branch claude/project-thread-ara09s.
