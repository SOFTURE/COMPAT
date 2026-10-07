---
change_id: config-key-normalization
title: "One configuration setting spelled several ways is one config finding"
status: archived
roadmap_item: null
issue: 18
branch: claude/project-thread-u4ez1n
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
The `config` layer compares keys by their exact spelling, so one setting read along the deploy chain as
`Shop:BaseUrl`, `Shop__BaseUrl`, `SHOP_BASE_URL` and the .NET section `Shop` plus member `BaseUrl` gives one finding
per spelling (5 findings for one new section on PETSEO `2.2.4 -> 2.3.4`). Keys are normalized to one canonical form
before comparison, a `regex` source can build a key from several groups and from an enclosing match, and any source
can carry a static `prefix`.

## Context
GitHub issue #18; backlog item "config-layer: normalize configuration keys across naming schemes".
Issues #19 (`chains`) and #20 (`presence`) match keys with the same normalization, so it lives in its own module.

## Constraints
- Owns `src/layers/config/` only; no core, report or other layer change.
- English in everything committed.

## Notes
- 2026-10-07: opened from issue #18, implemented and archived on branch claude/project-thread-u4ez1n.
