# Implementation review: msbuild-properties

Scope: full · Date: 2026-10-07 · Commits: 23e157a..1487259 · Gates: typecheck ✓ lint ✓ test ✓ (893 passed, 22 skipped) · build ✓ test:pack ✓

## Verdict
Ready after fixes. An independent read-only reviewer ran realistic MSBuild inputs through `evaluateMsbuildProperties`
and `readNuget`. Backslash and `..` imports, `$(MSBuildThisFileDirectory)` at the root, multi-line imports in
`<ImportGroup>`, self-closing groups, `>` inside a condition, `GetPathOfFileAbove`, cycles and a standalone
`Directory.Packages.props` were all correct; no regression in the classifier or the layer. Three warnings, each a
silently wrong version, were found and fixed in 1487259.

## Dimensions
| Dimension | Verdict | Findings |
| --- | --- | --- |
| Plan coverage | PASS | - |
| Correctness | FAIL → fixed | W1, W2, W3 |
| Tests | PASS | - |
| Patterns | PASS (result types, injected reader, per-scan cache) | - |
| Security | PASS (only files of the same commit; paths leaving the repository refused) | - |
| Scope | PASS (`src/layers/dependencies/` and README only) | - |
| Language | PASS (no non-English text in the diff) | - |

## Findings
### W1 [WARNING] Property groups inside a `<Target>` applied at load time
`Directory.Build.targets` usually holds targets; a `PropertyGroup` there overrode the project's value.
**Fix:** targets blanked before matching (offsets kept). **Status:** fixed, test added.

### W2 [WARNING] Properties expanded lazily against the final values
`<EfVersion>$(Base)</EfVersion>` followed by a later `<Base>` gave the later value; `<V>$(V)-preview</V>` grew per round.
**Fix:** expansion at definition time; items expand once. **Status:** fixed, test added.

### W3 [WARNING] Conditions ignored even where decidable; per-framework values silently last-wins
**Fix:** `'$(Name)' == ''` / `!= ''` decided; different values under other conditions make the property ambiguous
and the version `dependency-changed` with the values listed. **Status:** fixed, tests added.

### S1 [SUGGESTION] File names are matched case-sensitively
A Windows-authored `Directory.build.props` is not found. **Status:** left as is; git trees are case-sensitive and
MSBuild on Linux CI behaves the same.
