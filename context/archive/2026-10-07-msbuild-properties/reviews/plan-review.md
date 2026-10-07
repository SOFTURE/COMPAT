# Plan review: msbuild-properties

Reviewed: plan.md @ 2026-10-07. Mode: standard (self-review against research and the MSBuild import order).
Verdict: ready. Findings: 0 critical, 0 warning, 2 suggestion.

## Lenses
| Lens | Result |
| --- | --- |
| Coverage and end state | PASS (false negative from change.md is the phase 2 end-to-end case) |
| Slicing | PASS |
| Verifiability | PASS |
| Tests | PASS |
| Security | PASS (reads only files of the same commit; paths leaving the repository are refused) |
| Lean | PASS |
| Scope | PASS (`read-nuget.ts` owned; one small edit in the layer for CMP-10 to merge around) |
| Progress format | PASS |

## Findings

### S1 [SUGGESTION] `$(MSBuildProjectDirectory)` in an imported file means the project's folder
**Fix:** carry the evaluated file's folder through nested imports instead of the importing file's folder.
**Status:** taken into phase 1.

### S2 [SUGGESTION] A `.props` file matched by the default glob is evaluated as if it were a project
**Fix:** none; a standalone `.props` sees the same auto-imports a project in its folder would, which is the closest
answer without knowing which project imports it. Recorded here.
