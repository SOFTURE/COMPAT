# Plan: sql-preconditions

Input: change.md, issue #86. Complexity: small (one module, one layer hook, README).

## Goal
Acceptance (issue #86):
1. a command printing `dictionaries.PetBreeds\t417` turns the finding `safe` with that reason;
2. printing `...\t420` turns it `breaking`;
3. the command is not run when the revision has no `insert-explicit-id` finding.

## Approach
| Decision | Choice | Why |
| --- | --- | --- |
| Runner | `runProcess` with `shell: true`, as `presence` | same contract the config layer already documents |
| Input | tables in `COMPAT_TABLES`, one per line, as the report shows them | `runProcess` has no stdin; an env var keeps the runner unchanged |
| Output | `table<TAB>maxId`; empty or `NULL` max = empty table; other lines skipped | nothing else from the output is kept |
| Matching | table names go through `parseName`, so the key is schema.table lowercase with the dialect default schema | same identity the classifier uses |
| Sequence half | below the first id is `safe` only when the migration moves the identity sequence; otherwise it stays `needs-action` with the observed max | the max answers only the row half of the precondition |
| Order | preconditions before `accept` | an accept entry still marks the finding afterwards |

## Progress
- [x] Phase 1: `preconditions.ts`, schema on every source, classify carries explicit-id data
- [x] Phase 2: layer hook, unit and layer tests, README
- [x] Gates: typecheck, lint, test, build, test:pack
