---
change_id: oasdiff-download
title: "openapi: download a pinned, checksum-verified oasdiff when it is not on PATH"
status: archived
roadmap_item: backlog (later-layers.md), GitHub issue #13
branch: claude/project-thread-kkn4o1
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
A consumer without a Go toolchain gets the `openapi` layer working with no manual install: the CLI downloads the
pinned oasdiff release, verifies it against a checksum shipped in the package and caches it.

## Context
Dogfooding on PETSEO (macOS, no Go) needed a manual download, a manual checksum check and
`layers.openapi.oasdiff.path`. `locateOasdiff` only knew PATH and config; a missing binary skipped the layer.

## Constraints
- A tampered or failed download never yields `safe`: the layer reports `failed`.
- A second run works from the cache without network access.
- An explicit opt-out (`--no-download`, `SOFTURE_COMPAT_NO_DOWNLOAD`, `"download": false`) keeps the old `skipped`.
- No new runtime dependency; English in everything committed.

## Notes
- Archived 2026-10-07: downloader, CLI flag, config key, report source note and README shipped; backlog item ticked.
