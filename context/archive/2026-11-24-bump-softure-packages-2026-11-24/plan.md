# Plan: bump-softure-packages-2026-11-24

Input: change.md. Complexity: trivial (one devDependency, one CI pin, regenerated files).

## Goal
1. `@softure-ai/skills` is 0.34.0 in `package.json`, the lockfile and `node_modules` (newest on npm);
2. the CI `context-doctor` job runs `@softure-ai/skills@0.34.0`;
3. `npx softure-skills` refreshed the managed block; `npx softure-skills state` regenerated `context/state.json`;
   `npx softure-skills doctor` exits 0;
4. every gate in `context/workflow.json` passes, plus `npm run build` and `npm run test:pack`.

## What 0.34.0 changes for this project
| Change | Step for this project |
| --- | --- |
| `wt-roadmap.py released <tag>` (new `wt_release.py`): the session that sees a release through settles `context/` | none now; applies to the next release thread |
| Managed block: Releases paragraph names that step; package-update routine never runs it | refreshed by the installer |

## Decisions (auto)
- No new tests: the bump changes no project code.
- `context/state.json` regenerated; its content did not change.

## Progress
- [x] Install 0.34.0, run the installer, `state`, `doctor` (exit 0, "context/ contract OK")
- [x] CI doctor pin 0.33.0 -> 0.34.0
- [x] Gates: typecheck, lint, test, build, test:pack (all exit 0); language scan of the diff
