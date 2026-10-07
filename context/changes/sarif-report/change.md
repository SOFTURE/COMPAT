---
change_id: sarif-report
title: "The check can write SARIF for code scanning"
status: new
roadmap_item: CMP-14
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
`--format sarif` writes SARIF 2.1.0: one rule per finding id with its layer, level from the class (`breaking` error, `rollback-risk` and `needs-action` warning, `safe` note), locations from revision-side evidence, accepted findings as suppressions with their reason, skipped and failed layers as tool notifications.

## Context
Roadmap v2 item CMP-14. Code: `src/report/`, `src/cli.ts`. CMP-15 uploads this file from the GitHub Action.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- No new runtime dependency.
- Findings without a file anchor on the config file.

## Notes
- 2026-10-07: opened from roadmap v2.
