# Plan: bump-softure-skills-0-41-2

Input: change.md. Complexity: trivial (one devDependency, one CI pin, regenerated files).

## Goal
1. `@softure-ai/skills` is 0.41.2 in `package.json`, the lockfile and `node_modules` (newest on npm);
2. the CI `context-doctor` job runs `@softure-ai/skills@0.41.2`;
3. `npx softure-skills` refreshed the managed block; `npx softure-skills state` regenerated `context/state.json`;
   `npx softure-skills doctor` exits 0;
4. every gate in `context/workflow.json` passes, plus `npm run build` and `npm run test:pack`.

## What 0.41.2 changes for this project
| Change | Step for this project |
| --- | --- |
| A queued roadmap is listed only under `queued`, no longer as an `owner_queue` entry | `state` regenerated: no queued roadmap here, so `queued` and `owner_queue` stay empty (no diff) |

## Decisions (auto)
- No new tests: the bump changes no project code.

## Progress
- [x] Install 0.41.2 (`npm install -D @softure-ai/skills@0.41.2`; npm latest is 0.41.2), installer (managed block unchanged), `state` (no diff), `doctor` (exit 0, "context/ contract OK")
- [x] CI doctor pin 0.41.1 -> 0.41.2
- [x] Gates: typecheck, lint, test (4 passed), build, test:pack; language scan of the diff
