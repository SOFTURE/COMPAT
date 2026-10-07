---
change_id: message-contracts-layer
title: "Message contract and queue changes are reported before they break in-flight messages"
status: implementing
roadmap_item: null
issue: 16
branch: claude/project-thread-nwghre
created: 2026-10-07
updated: 2026-10-07
---

## Intent
`softure-compat check` gets a `message-contracts` layer. It parses the C# message contracts of both refs at source
level (no build) and the queue names a configured pattern finds, and classifies what changed for messages that sit in
a broker queue during a deploy or a rollback.

## Context
GitHub issue #16; backlog item `message-contracts` in `context/backlog/later-layers.md`; research F8 of
`context/archive/2026-10-07-backward-compat-checker/research.md`. PETSEO `2.2.4 -> 2.3.4`: three new message types
under `PETSEO.Contract.Internal.Messages/NotificationBroadcasts/`, a new queue `PETSEO.Worker.Sync.Broadcast`, no
changed contract. The tool must say exactly that (all `safe`). Moving a message to another namespace changes the
MassTransit message URN and must be `message-renamed`, `breaking`.

## Constraints
- Owns `src/layers/message-contracts/`; one line in `src/layers/registry.ts`, one detector in `src/commands/init.ts`,
  one README section (the README and init tests require both for every registered layer).
- Reuses the persisted-enums tokenizer, enum parser and enum comparison, and the config layer's comment stripper.
- Lesson `compat-scanner-lesson`: every literal form is covered by tests, and a type declaration the parser could
  not read fails the layer instead of reading as absent.
- ApiCompat as a precise mode stays in the backlog.

## Notes
- 2026-10-07: opened from issue #16.
