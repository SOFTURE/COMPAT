# Research: msbuild-properties

Input: change.md, roadmap v2 CMP-9. Depth: normal.
Snapshot: 23b243c on master, 2026-10-07.

## Summary
- `readNuget` (`src/layers/dependencies/read-nuget.ts`) expands `$(Name)` only from the declaring file's
  `PropertyGroup`s; an unknown property stays as written. `Version="$(MassTransitVersion)"` with the value in
  `Directory.Build.props` therefore reads `$(MassTransitVersion)` at both refs and `compareDeclarations`
  (`classify.ts`) sees no difference: an upgrade of the property produces no finding (the false negative).
- The layer reads files through `RefTree.readFile(path)` (`null` when absent, `src/git/ref-tree.ts`), so any
  other file of the same commit (auto-imported or explicitly imported) can be read on demand without listing.
- MSBuild (SDK projects) evaluates properties in import order and the last definition wins; items are evaluated
  after every property, so a package version sees the final property values. The order for a project is: the
  nearest `Directory.Build.props` (from `Microsoft.Common.props`), the nearest `Directory.Packages.props`
  (central package management, after `Directory.Build.props`), the project body with its `<Import>`s in place,
  then the nearest `Directory.Build.targets`.
- MSBuild imports only the **nearest** `Directory.Build.props`; a parent one is loaded only when the child imports
  it explicitly, usually with
  `$([MSBuild]::GetPathOfFileAbove('Directory.Build.props', '$(MSBuildThisFileDirectory)../'))`.
  Import paths commonly start with `$(MSBuildThisFileDirectory)`.
- `Condition` evaluation stays out (roadmap v2 rejected it).
- No SOFTURE module applies. No data, no external tool.

## Affected surface
| Area | Files | Why |
| --- | --- | --- |
| Property evaluation | `src/layers/dependencies/msbuild-properties.ts` (new) | import chain, path resolution |
| Reader | `src/layers/dependencies/read-nuget.ts` | owned by CMP-9; takes evaluated properties |
| Declaration | `src/layers/dependencies/declaration.ts` | carries why a version stayed unresolved |
| Classification | `src/layers/dependencies/classify.ts` | names the reason in `dependency-changed` |
| Layer | `src/layers/dependencies/dependencies-layer.ts` | evaluates per file, notes unresolved versions |
| Docs | `README.md` (dependencies section) | the `nuget` row says "resolved from the same file" |
| Tests | `test/layers/dependencies/*`, `test/e2e/dependencies.test.ts` | new cases |

## Tests
- vitest; gates from `context/workflow.json`: `npm run typecheck`, `npm run lint`, `npm test`.
- End to end via `createRepo` + `main([...], io)` (`test/e2e/dependencies.test.ts`).

## Risks
- CMP-10 (`dependency-lockfiles`) touches `dependencies-layer.ts` in parallel: keep the edit there small.
- An import with a user property in its path cannot be resolved without evaluating MSBuild expressions: it must be
  reported, never guessed.
