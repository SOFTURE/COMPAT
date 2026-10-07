---
change_id: github-action
title: "A GitHub Action runs the check and puts the report where reviewers look"
status: new
roadmap_item: CMP-11
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
`action.yml` at the repository root (`uses: SOFTURE/COMPAT@v0`) runs `softure-compat check` with inputs for base, revision, fail-on, config and extra arguments, writes the Markdown report to `$GITHUB_STEP_SUMMARY`, and on pull requests creates or updates one comment found by a hidden marker. `release.yml` moves the `v0` major tag on release.

## Context
Roadmap v2 item CMP-11. README "In CI" today writes the report to a file in the job, where nobody reads it unless the gate fails; the findings that matter most (`needs-action`) do not fail the default gate, so they must be visible on the release pull request. The action turns the manual recipe into one step.

## Constraints
- English in everything committed; own implementation, no dependency on `@softure-ai/*`.
- Composite action that runs the published CLI; no bundled JavaScript.
- The action pins the CLI version it is released with.
- The comment step needs `pull-requests: write` and is skipped on non-PR events or forks without the permission.

## Notes
- 2026-10-07: opened from roadmap v2.
