# Plan: close-roadmap-v2

Input: change.md. Complexity: trivial (one context file moved and summarised, regenerated state).

## Goal
1. every roadmap v2 row is `done` with evidence: the merge commit on `master` that brought its archived change
   folder, and the release that carried it;
2. `wt-roadmap.py released v0.14.0` runs only when a row still waits for a release;
3. the roadmap carries `## Summary` (`| ID | Item | What changed | Merge |`, release line) and lives at
   `context/foundation/archive/2026-11-24-roadmap-v2.md`; `context/foundation/roadmap.md` is gone;
4. `context/state.json` regenerated (no active roadmap, `last_release` v0.14.0); doctor exits 0;
5. gates in `context/workflow.json` pass.

## Evidence (gathered 2026-11-24)
Merge commit = the first `master` first-parent commit whose tree holds `context/archive/<date>-<change-id>/`.

| ID | Change | Merge on `master` | PR |
| --- | --- | --- | --- |
| CMP-7 | `seed-silent-writes` | ef90dd8 | #51 |
| CMP-8 | `compose-scanning-gaps` | 295d793 | #50 |
| CMP-9 | `msbuild-properties` | b691aeb | #53 |
| CMP-10 | `dependency-lockfiles` | 6e0f15a | #52 |
| CMP-11 | `github-action` | 8a0fb0d | #49 |
| CMP-12 | `release-0-3-0` | c235f9d | #63 |

- GitHub Release `v0.3.0` (published 2026-10-07 by `release.yml`, target c235f9d) lists PRs #49-#53 and #63: the
  first release carrying all six items.
- GitHub Release `v0.14.0` (published 2026-10-08, target 1b1caca, release run 37822475438 green); all six merges are
  ancestors of 1b1caca.
- npm: `@softure-ai/compat` dist-tag `latest` = `0.14.0`; 0.3.0 and 0.14.0 are both published.
- Gates of `--close`: all rows `done`; `context/changes/` holds only README.md; `integration` not configured; the
  roadmap has no `## Owner decisions and checks` or `## Before the next release` entries.

## Decisions (auto)
- `wt-roadmap.py released v0.14.0` not run: no row is `done_code (…; waiting: release)` (all six were `done` since
  2026-10-07), so it would settle nothing.
- The Summary release line names `v0.14.0 (2026-10-08)` (the owner's word and the current npm `latest`, so
  `state.json` `last_release` reads it); the line above it records that `v0.3.0` first shipped the roadmap.
- CMP-11's outcome text still says `@v0` and a moving tag; the Summary notes that PR #67 replaced it with `@vX.Y.Z`
  instead of rewriting the item block.
- Archive name `2026-11-24-roadmap-v2.md`, following `2026-10-07-roadmap-v1.md`.

## Progress
- [x] Rows verified against `master`, Releases `v0.3.0` and `v0.14.0` (run 37822475438) and npm (`latest` 0.14.0); all six already `done`
- [x] `released v0.14.0` skipped: no row waits for a release
- [x] `## Summary` written, roadmap moved to `context/foundation/archive/2026-11-24-roadmap-v2.md`; README and backlog links updated
- [x] `context_state.py write --staged` (no active roadmap, `last_release` v0.14.0); `doctor.py` exit 0
- [x] Gates: typecheck, lint, test (all exit 0); language scan of the diff
