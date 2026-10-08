# Plan: ota-refs

Input: change.md, issue #93. Complexity: small (ref list, one new resolver module, README).

## Goal
Acceptance (issue #93):
1. `[{ workflowRuns: "eas-prod.yml" }, { workflowRuns: "eas-update-prod.yml", optional: true }]` passes when the
   second workflow has no run, with a note naming it;
2. an OTA command printing two commits adds two client refs (`mobile@ota:<label>`), and a call kept only by an OTA
   bundle keeps its class;
3. a dirty-tree update adds a note.

## Approach
| Decision | Choice | Why |
| --- | --- | --- |
| `optional` | on every object entry, plus `{ ref, optional }` for a plain ref or resolver | a string entry has no room for a flag |
| Optional failure | any resolution error becomes a note `optional entry skipped: <error>` | the error already names the entry and the cause |
| Empty list | fails when no entry resolves | a client with no ref proves nothing |
| `easUpdates` | `{ run, timeoutSeconds? }` run with `shell: true` in the repo, as `presence` / `preconditions` | no Expo token in the tool; the command picks branch and period |
| Output | `commit<TAB>label[<TAB>dirty]`; distinct commits, first label wins; ref `ota:<label>` | matches `eas update:list --json` piped through `jq` |
| Notes | `resolveRefList` returns `{ refs, notes }`; `formatResolvers` prefixes the client | both layers already print resolver notes |

## Progress
- [x] Phase 1: `ota-updates.ts`, ref list schema and notes, both layers
- [x] Phase 2: unit and layer tests, README
- [x] Gates: typecheck, lint, test, build, test:pack
