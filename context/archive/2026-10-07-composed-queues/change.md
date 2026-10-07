---
change_id: composed-queues
title: "Queue names composed at runtime from parts found by other queue sources"
status: archived
roadmap_item: null
issue: 47
branch: claude/project-thread-yod6s6
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
Brokers such as `SOFTURE.MessageBroker.Rabbit` 1.x build endpoint names at runtime:
`{Rabbit:Name}{GroupSeparator}{group}`. The `regex` queue source sees the endpoint (`PETSEO.Worker.Sync`) and the
group (`Broadcast`) as two unrelated names, so the real queue (`PETSEO.Worker.Sync.Broadcast`) never appears, and a
separator or endpoint change that renames every group queue gives no finding. A `composed` queue source builds the
names from the captures of other queue sources and compares them like any other queue source.

## Context
GitHub issue #47 (from a PETSEO 2.2.4 -> 2.3.5 run). The issue proposes the `composed` shape; the alternative
(`prefix` per regex source) cannot express a separator coming from configuration, so it is not built.

## Constraints
- Owns `src/layers/message-contracts/` (config, layer, a new module), its tests, and the README section.
- No change to core, report, init or other layers.
- English in everything committed.

## Notes
- 2026-10-07: opened from issue #47 on branch claude/project-thread-yod6s6.
- 2026-10-07: implemented and archived on branch claude/project-thread-yod6s6.
