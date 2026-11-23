# Plan: bump-skills-0-33-0

Input: change.md. Complexity: trivial (one devDependency, one CI pin, regenerated files).

## Goal
1. `@softure-ai/skills` is 0.33.0 in `package.json`, the lockfile and `node_modules`;
2. the CI `context-doctor` job runs `@softure-ai/skills@0.33.0`;
3. `npx softure-skills` refreshed the managed block; `npx softure-skills state` regenerated `context/state.json`;
   `npx softure-skills doctor` exits 0, with no `roadmap-item-shape` finding;
4. every gate in `context/workflow.json` passes, plus `npm run build` and `npm run test:pack`.

## What 0.31.0..0.33.0 change for this project
| Change | Step for this project |
| --- | --- |
| `ci-doctor-trigger`: the `context-doctor` job must run on `pull_request` and on `push` to the main branch, unfiltered | already true in `ci.yml`; none |
| WORKFLOW §14 infrastructure and deploy rules in the managed block | none (no deploy work here) |
| `roadmap-item-shape`: every `### ID: Title` block has an at-a-glance row with the same status | roadmap v2 already matches (CMP-7..CMP-12, all `done`); doctor reports no finding |

## Decisions (auto)
- No `doctor --fix --write`: the doctor reports no finding, so there is nothing to fix.
- No new tests: the bump changes no project code.

## Progress
- [x] Install 0.33.0, run the installer, `state`, `doctor` (exit 0, "context/ contract OK")
- [x] CI doctor pin 0.30.0 -> 0.33.0
- [x] Gates: typecheck, lint, test, build, test:pack; language scan of the diff
