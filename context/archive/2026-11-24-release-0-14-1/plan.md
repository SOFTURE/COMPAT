# Plan: release-0-14-1

Input: change.md. Complexity: trivial (version bump).

## Goal
1. `package.json` and `package-lock.json` carry 0.14.1;
2. `README.md` and `action.yml` name `v0.14.1` where they named `v0.14.0`;
3. every gate in `context/workflow.json` passes, plus `npm run build` and `npm run test:pack`;
4. after the merge, `release.yml` publishes 0.14.1 to npm and creates the GitHub Release `v0.14.1`.

## Decisions (auto)
- Patch, not minor: since v0.14.0 only dev dependencies, CI, `AGENTS.md`, `context/` and one README link changed;
  the CLI behaves the same.

## Progress
- [x] `npm version 0.14.1 --no-git-tag-version`; README and action.yml references updated
- [x] Gates: typecheck, lint, test, build, test:pack; language scan of the diff
