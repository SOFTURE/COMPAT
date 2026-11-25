# Plan: bump-softure-skills-0-41-1

Input: change.md. Complexity: trivial (one devDependency, one CI pin, regenerated files, one config key).

## Goal
1. `@softure-ai/skills` is 0.41.1 in `package.json`, the lockfile and `node_modules` (newest on npm);
2. the CI `context-doctor` job runs `@softure-ai/skills@0.41.1`;
3. `npx softure-skills` refreshed the managed block; `npx softure-skills state` regenerated `context/state.json`;
   `npx softure-skills doctor` exits 0;
4. every gate in `context/workflow.json` passes, plus `npm run build` and `npm run test:pack`.

## What 0.37.0..0.41.1 change for this project
| Change | Step for this project |
| --- | --- |
| `owner-word` issues renamed to `cockpit` issues; the owner-word wake routine replaced by the COCKPIT command routine (`routines/cockpit-command.md`) | managed block refreshed; `autonomy.ownerWordWake` removed from `workflow.json` (the package no longer reads it); the COCKPIT command task is set up outside the repository |
| Threads and the heartbeat read the main branch's CI (`wt-main-ci.py`) | managed block refreshed |
| The main branch must require every pull-request CI job (`doctor --protection`) | `doctor --protection` reports `main-checks-not-required` on `master`: only the owner can turn branch protection on, so it goes to the owner |

## Decisions (auto)
- No new tests: the bump changes no project code.

## Progress
- [x] Install 0.41.1 (`npm install -D @softure-ai/skills@0.41.1`; npm latest is 0.41.1), run the installer, `state` (no diff), `doctor` (exit 0, "context/ contract OK")
- [x] CI doctor pin 0.37.0 -> 0.41.1; `autonomy.ownerWordWake` removed
- [x] `doctor --protection`: `FAIL main-checks-not-required` (owner step, branch protection)
- [x] Gates: typecheck, lint, test, build, test:pack; language scan of the diff
