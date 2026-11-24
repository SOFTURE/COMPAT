# Plan: bump-softure-packages-2026-11-24-c

Input: change.md. Complexity: trivial (one devDependency, one CI pin, regenerated files).

## Goal
1. `@softure-ai/skills` is 0.37.0 in `package.json`, the lockfile and `node_modules` (newest on npm);
2. the CI `context-doctor` job runs `@softure-ai/skills@0.37.0`;
3. `npx softure-skills` refreshed the managed block; `npx softure-skills state` regenerated `context/state.json`;
   `npx softure-skills doctor` exits 0;
4. every owner-queue entry answered "later" is moved to `context/foundation/roadmaps/roadmap-later.md` with its old row
   marked carried (0.37.0 rule);
5. every gate in `context/workflow.json` passes, plus `npm run build` and `npm run test:pack`.

## What 0.36.0..0.37.0 change for this project
| Change | Step for this project |
| --- | --- |
| Every owner answer (yes/no/later) removes the entry from the owner queue; "later" moves the item to `roadmaps/roadmap-later.md` as a new item, old row `carried` | none to migrate: `owner_queue` in `context/state.json` is empty and no entry in `context/` carries `(later: #N)`; no later roadmap is created empty |
| Managed block: the settling rule above | refreshed by the installer |

## Decisions (auto)
- No `roadmap-later.md` is created: there is nothing to carry into it, and an empty roadmap file would only add noise.
- No new tests: the bump changes no project code.

## Progress
- [x] Install 0.37.0 (`npm install -D @softure-ai/skills@latest`; npm latest is 0.37.0), run the installer, `state` (no diff), `doctor` (exit 0, "context/ contract OK")
- [x] Owner queue checked: empty in `context/state.json`; `grep "(later"` over `context/` finds no answered entry
- [x] CI doctor pin 0.36.0 -> 0.37.0
- [x] Gates: typecheck, lint, test, build, test:pack (all exit 0); language scan of the diff
