---
change_id: protobuf-layer
title: "Breaking changes in protobuf contracts are found with buf"
status: new
roadmap_item: CMP-17
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
A `protobuf` layer runs `buf breaking` between the refs for configured modules (`buf.yaml` or a folder of `.proto` files), with the `WIRE_JSON` rule set by default, classes per rule and an accept allowlist; `buf` is downloaded pinned and verified through the shared helper from CMP-8; `init` detects `buf.yaml`.

## Context
Roadmap v2 item CMP-17. Stack-agnostic adapter (AGENTS.md); the gRPC counterpart of the `openapi` layer. Starts after CMP-8 is merged.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- A missing binary reads as `skipped`, never `safe`.
- Adds one line to the layer registry and one config entry.

## Notes
- 2026-10-07: opened from roadmap v2.
