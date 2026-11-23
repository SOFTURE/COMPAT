# Plan: bump-softure-packages-2026-11-23

Input: change.md. Complexity: trivial (one devDependency, one CI pin, regenerated files).

## Goal
1. `@softure-ai/skills` is 0.30.0 in `package.json`, the lockfile and `node_modules`, equal to `npm view` latest;
2. the CI doctor job runs `@softure-ai/skills@0.30.0`;
3. `npx softure-skills` refreshed `.claude/skills/` and the managed block; `npx softure-skills state` regenerated
   `context/state.json`; `npx softure-skills doctor` exits 0;
4. every gate in `context/workflow.json` passes, plus `npm run build` and `npm run test:pack`.

## Release notes crossed (SOFTURE/skills)
| Version | Change | Step for this project |
| --- | --- | --- |
| 0.25.0 | `project` pinned in `workflow.json` | already set (`SOFTURE COMPAT`) |
| 0.26.0 | one item = one change = one thread | managed block refreshed by the installer |
| 0.27.0 | routines ship in the package | scheduled-task setup is the coordinator's, not code |
| 0.28.0 | doctor prints failure codes in the job log | none |
| 0.29.0 | package updates bump and fix, never skip | none |
| 0.30.0 | roadmap heartbeat under `routines/` | report routines are off in this project; none |

## Decisions (auto)
- No new tests: the bump changes no project code (routine step 4).

## Progress
- [x] Install 0.30.0, run the installer, `state`, `doctor` (exit 0)
- [x] CI doctor pin 0.24.0 -> 0.30.0
- [x] Gates: typecheck, lint, test, build, test:pack; language scan of the diff
