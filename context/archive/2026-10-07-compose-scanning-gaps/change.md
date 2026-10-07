---
change_id: compose-scanning-gaps
title: "The config layer reads every compose variable reference, including block scalars and pass-through entries"
status: archived
roadmap_item: CMP-8
branch: claude/compose-scanning-gaps-x7qxx5
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
The compose reader of the `config` layer finds `${VAR}` inside YAML block scalars (`|`, `>`) even after ` #`, treats pass-through entries (`environment: [KEY]`, `KEY:` without a value) as keys required from the host, reads multi-line quoted scalars, and no longer keeps a trailing comment in a plain scalar that contains an apostrophe.

## Context
Roadmap v2 item CMP-8. Backlog config-layer entry; `context/archive/2026-10-07-config-layer/reviews/impl-review.md`. Every miss is a false negative of the layer's one promise: a release that needs a new secret in production passes the gate, and the deploy fails or runs without it. Pass-through `environment` entries are a common compose idiom. Code: `src/layers/config/`.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- No YAML library unless the research shows the hand scanner cannot hold; then a small, well-known one.
- README notes that more keys may surface after upgrading.

## Notes
- 2026-10-07: opened from roadmap v2.
