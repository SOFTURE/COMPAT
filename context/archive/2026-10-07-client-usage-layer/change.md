---
change_id: client-usage-layer
title: "OpenAPI findings are re-classified by what live client builds actually call"
status: archived
roadmap_item: null
issue: 14
branch: claude/project-thread-k7chbq
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
`softure-compat check` gets a `client-usage` layer. For each configured client (an API name, a list or tag
pattern of live client refs, a generated TypeScript client and optional call-site sources) it reads what every
client ref calls and sends, then re-classifies the `openapi` findings of that API with evidence: an operation no
live client calls drops to `safe`; a request property every calling ref always sends turns
`request-property-became-not-nullable` / `-became-required` / `new-required-request-property` into `safe`; anything
a client still uses keeps its class and names the client and ref.

## Context
GitHub issue #14, research F2 (`context/archive/2026-10-07-backward-compat-checker/research.md`). PETSEO
`2.2.4 → 2.3.4` reports `daysOfWeek` became not nullable, while every mobile build always sends an array; today
the only answer is a free-text `accept` entry that goes stale silently. Backlog item `client-usage` in
`context/backlog/later-layers.md`.

## Constraints
- Layers do not see each other's results today (`LayerContext` has no results). The core gains a refinement step
  in `src/commands/check.ts`; other layers stay untouched.
- Shared files with parallel threads: `check.ts`, `registry.ts`, `openapi/classify.ts`. Merge master before merging.
- No network, no new runtime dependency. A parser miss must never read as "not called" (lesson from CMP-4).
- English in everything committed. Issue #15 builds on this layer.

## Notes
- 2026-10-07: opened from issue #14.
- 2026-10-07: implemented on branch claude/project-thread-k7chbq; gates green (typecheck, lint, 660 tests, test:pack); archived.
