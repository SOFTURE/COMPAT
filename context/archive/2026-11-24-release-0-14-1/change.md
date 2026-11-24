---
status: archived
roadmap_item: null
---

# Change: release-0-14-1

Source: the owner's word in the project chat (2026-11-24): release a new version and close every open topic.
Release the work merged since v0.14.0 as a patch: `package.json` 0.14.0 -> 0.14.1, and the version references
in `README.md` and `action.yml`. Merging the bump to `master` lets `release.yml` publish it.

Scope: `package.json`, `package-lock.json`, `README.md`, `action.yml`, this archive folder.
Out of scope: any source change; the moving `v0` tag (removed in PR #67).

## Notes
- research skipped: `git diff v0.14.0..origin/master` is the research; it holds no change under `src/` or `test/`.

## Roadmap handoff
- Status: done
- Done: release 0.14.1 (dependency bumps, context cleanup, roadmap v2 archive since v0.14.0)
