---
change_id: github-action
title: "A GitHub Action runs the check and puts the result where reviewers look"
status: new
roadmap_item: CMP-15
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
`action.yml` at the repository root (`uses: SOFTURE/COMPAT@v0`) runs `softure-compat check` with inputs for base, revision, fail-on, config and extra arguments, writes the Markdown report to `$GITHUB_STEP_SUMMARY`, creates or updates one pull request comment found by a hidden marker, and optionally uploads the SARIF report for code scanning. `release.yml` moves the `v0` major tag on release.

## Context
Roadmap v2 item CMP-15. README "In CI" is today's manual recipe. Needs `--format sarif` from CMP-14.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- Composite action, no bundled JavaScript runtime code beyond the CLI.
- The action pins the CLI version it is released with.
- The PR comment step needs `pull-requests: write` and is skipped on non-PR events.

## Notes
- 2026-10-07: opened from roadmap v2.
