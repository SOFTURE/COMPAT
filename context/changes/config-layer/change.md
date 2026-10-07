---
change_id: config-layer
title: "New required configuration keys are reported before the deploy that needs them"
status: implemented
roadmap_item: CMP-5
branch: claude/project-thread-h321jp
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
`softure-compat check` gets a `config` layer. It collects configuration keys from both refs and reports a new key
without a default as `needs-action` (the value or secret must exist in production before the deploy), a new key
with a default as `safe`, and a key whose default was removed as `needs-action`.

## Context
Roadmap item CMP-5. Design input: research §4 layer 7. Acceptance fixture: F10 (new required settings
`Shop__BaseUrl`, `Shop__ApiKey` → `needs-action`; evidence `ApiSettings.cs:42`, an Ansible `assert`).

Sources to support (refine in research/plan): compose files (`${VAR}` required, `${VAR:-default}` optional,
`${VAR:?message}` required), `.env` example files, and configured regex sources (file glob plus a pattern with a
capture group for the key and an optional one for the default), so stack-specific places such as .NET `required`
settings or Ansible asserts can be described without code. Comments are stripped per source kind.

## Constraints
- Builds on CMP-1; independent of CMP-2, CMP-3 and CMP-4.
- Owns `src/layers/config/`. Touches the layer registry and the config schema with one entry each.
- Own implementation, no dependency on `@softure-ai/*` (change.md of CMP-1). English in everything committed.

## Notes
- 2026-10-07: opened from roadmap v1.
