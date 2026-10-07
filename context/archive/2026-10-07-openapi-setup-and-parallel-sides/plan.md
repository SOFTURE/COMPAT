# Plan: openapi-setup-and-parallel-sides

Input: change.md, issue #12, `src/layers/openapi/*`. Complexity: medium.

## Goal
`layers.openapi.setup` runs exactly once per side before any spec source of that side; base and revision are
prepared concurrently unless `concurrency` is 1.

**Out of scope:** a global (cross-layer) setup; running APIs of one side in parallel (they share one tree and,
typically, one build output); parallel oasdiff runs (cheap compared with builds).

## Approach
**Starting point:** `openapi-layer.ts` looped over APIs; `checkApi` resolved the base spec, then the revision spec,
then ran oasdiff. Command execution lived inside `spec-source.ts`.

**Chosen:** split the run into "prepare sides" and "compare APIs". `prepareSide(tree)` materializes the tree, runs
`setup`, then resolves every API's spec in config order, keeping one `Result` per API. `prepareSides` runs the two
sides with `Promise.all`, or one after the other with `concurrency: 1`, and waits for both before reporting a setup
failure. `checkApi` then compares the already-resolved specs. The shell command runner moved to `tree-command.ts`
and is shared by `setup` and `command` sources, so errors read the same (`setup command at revision (v2) exited 2:
<stderr tail>`).
Rejected: a global `setup` at config root - only the openapi layer runs consumer commands today.

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Where `setup` lives | `layers.openapi.setup` | the only layer that runs consumer commands | issue #12 |
| `concurrency` | integer 1..2, default 2 | there are exactly two sides | issue #12 |
| APIs within a side | sequential | they share one tree; parallel exports would race on build outputs | plan |
| Setup fails on one side | layer `failed`, no findings, both sides still finish | a broken build makes every spec of that side unknown | plan |
| Setup timeout | default 600 s, max 7200 s, as `command` sources | one rule for consumer commands | plan |

## Phase 1: Config, layer, docs
1. `config.ts`: `setup`, `concurrency`.
2. `tree-command.ts`: shared runner; `spec-source.ts` uses it.
3. `openapi-layer.ts`: `prepareSides`, `prepareSide`, `checkApi` on resolved specs.
4. README openapi section.

**Tests:** setup counter file with 3 command APIs (exactly `base v1`, `revision v2`); setup failing at one side and
at both; a barrier setup proving overlap by default and no overlap with `concurrency: 1`; config schema cases.

## Risks and rollback
- Two builds at once may exhaust a small runner: `concurrency: 1`.
- Rollback: revert the commit; configs without `setup`/`concurrency` behave as before, apart from the sides overlapping.

## Progress
### Phase 1: Config, layer, docs
- [x] Config schema
- [x] Shared tree command runner
- [x] Layer split into prepare and compare
- [x] README
- [x] Tests (typecheck, lint, full suite green)
