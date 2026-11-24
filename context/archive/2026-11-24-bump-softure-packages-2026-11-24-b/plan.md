# Plan: bump-softure-packages-2026-11-24-b

Input: change.md. Complexity: trivial (one devDependency, one CI pin, one config key, regenerated files).

## Goal
1. `@softure-ai/skills` is 0.36.0 in `package.json`, the lockfile and `node_modules` (newest on npm);
2. the CI `context-doctor` job runs `@softure-ai/skills@0.36.0`;
3. `context/workflow.json` declares `autonomy.ownerWordWake: "none"`;
4. the repository has the label `owner-word`;
5. `npx softure-skills` refreshed the managed block; `npx softure-skills state` regenerated `context/state.json`;
   `npx softure-skills doctor` exits 0 with no owner-word-wake note;
6. every gate in `context/workflow.json` passes, plus `npm run build` and `npm run test:pack`.

## What 0.35.0..0.36.0 change for this project
| Change | Step for this project |
| --- | --- |
| `autonomy.ownerWordWake` (`routine` / `heartbeat` / `none`), noted by the doctor when missing | set to `none`: no GitHub-triggered wake task could be created for this repository yet |
| Owner-word wake routine (`routines/owner-word-wake.md`) and its claim marker | none in the repository; the routine is a scheduled task, not a file |
| Managed block: settling `routines.packageUpdates.*` owner-queue entries, owner-word wake paragraph | refreshed by the installer |

## Decisions (auto)
- `ownerWordWake: "none"`: the coordinator could not create a GitHub-triggered task; switch to `"routine"` once it exists.
- No new tests: the bump changes no project code.

## Progress
- [x] Install 0.36.0, run the installer, `state`, `doctor` (exit 0, "context/ contract OK", no owner-word-wake note)
- [x] `autonomy.ownerWordWake: "none"` in `context/workflow.json`
- [x] Label `owner-word` exists on the repository (checked through the GitHub API; nothing to create)
- [x] CI doctor pin 0.34.0 -> 0.36.0
- [x] Gates: typecheck, lint, test, build, test:pack (all exit 0); language scan of the diff
