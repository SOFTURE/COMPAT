# Plan: msbuild-properties

Input: change.md, research.md. Complexity: low-medium (2 phases; one pure-ish evaluator with an injected file
reader, small edits in the reader, classifier and layer).

## Goal
A NuGet version written as `$(Property)` resolves from the properties MSBuild would see for that file:
the nearest `Directory.Build.props`, the nearest `Directory.Packages.props`, the file itself with its in-repository
`<Import>`s in document order, and the nearest `Directory.Build.targets`; the last definition wins, as in MSBuild.
Upgrading `MassTransitVersion` in `Directory.Build.props` from `8.1.0` to `8.2.0` gives `MassTransit
dependency-upgraded safe`. A version that still holds `$(...)` stays `dependency-changed` when it differs between
the refs, with a message naming the undefined property and any import that was not followed; an unresolved version
that is the same at both refs is listed in the layer notes, never silent.

**Out of scope:** `Condition` evaluation (roadmap v2 rejected), property functions other than
`GetPathOfFileAbove` in import paths, SDK imports (`Sdk="..."`), environment and command-line properties, lockfiles
(CMP-10).

## Approach
**Chosen:** a new `msbuild-properties.ts` that evaluates the property map of one MSBuild file at one ref, given a
`readFile` function (the `RefTree`'s, cached per scan). `readNuget` takes that map (and the list of imports that
could not be followed) instead of reading only its own properties; without it, it keeps today's behaviour, so
`readNuget` stays pure and synchronous.
Rejected: reading every `Directory.Build.props` up the folder tree (the literal "chain" in change.md) - MSBuild loads
only the nearest one, so a parent value would be a wrong answer whenever the child does not import its parent;
the explicit `GetPathOfFileAbove` import covers real chains. Expanding user properties in import paths - MSBuild
expands them at definition time (`$(MSBuildThisFileDirectory)` of another file), lazy expansion would resolve to the
wrong folder.

**Key decisions:**
| Decision | Choice | Why |
| --- | --- | --- |
| Auto-imports | nearest `Directory.Build.props`, `Directory.Packages.props`, `Directory.Build.targets` from the file's folder up to the repository root; a file never auto-imports a file of its own name | MSBuild `Microsoft.Common.props`/`.targets` behaviour |
| Order | auto props → central props → file body (property groups and imports in document order) → auto targets; last definition wins; `$(...)` expanded after all properties are known | items are evaluated after properties |
| Supported import paths | relative paths, `$(MSBuildThisFileDirectory)`, `$(MSBuildProjectDirectory)`, `$([MSBuild]::GetPathOfFileAbove('name'[, 'start']))`; `\` read as `/` | the common forms in .NET repositories |
| Imports not followed | a path with another property, a wildcard, an absolute path, a path outside the repository, or a missing file without `Condition` → recorded as `<file>: <import> (<reason>)` | change.md: fail visibly, never silently resolve |
| Missing file with `Condition` | skipped without a problem | the usual `Exists(...)` guard |
| `Sdk` imports | skipped | not repository files |
| Cycles | each file applied once per evaluation | an import loop must not hang |
| Unresolved reason | `Declaration.unresolved` (optional string on NuGet declarations) | the classifier prints it in `dependency-changed` |
| Same unresolved text at both refs | no finding; layer note lists up to 5 `path:line $(Name)` per ref | nothing comparable changed in the repository, but it must not be silent |

## Phases

### Phase 1: Property evaluation and reader
- `msbuild-properties.ts`: `evaluateMsbuildProperties({ path, readFile })` → `Result<{ properties, skippedImports }>`.
- `read-nuget.ts`: `readNuget(text, path, evaluated?)`; sets `unresolved` when `$(` remains.
- `classify.ts`: `dependency-changed` message names the reason.
- Tests: `test/layers/dependencies/msbuild-properties.test.ts` (nearest file only, order and override, explicit
  import, `$(MSBuildThisFileDirectory)`, `GetPathOfFileAbove` chain, property path, outside repository, missing with
  and without `Condition`, cycle, `Sdk` import), `readers.test.ts` (evaluated map, unresolved reason),
  `classify.test.ts` (reason in message).

### Phase 2: Layer wiring, end to end, README
- `dependencies-layer.ts`: evaluate per NuGet file with a per-scan read cache; note unresolved versions.
- `test/e2e/dependencies.test.ts`: property upgraded in `Directory.Build.props` and in an imported `.props` reported,
  unresolved property changed reported with reason.
- README `nuget` row and `dependency-changed` row updated.

## Decisions (auto)
- Complexity → low-medium, two phases.
- "Chain up the folder tree" read as MSBuild does it: nearest file plus explicit imports (see Rejected).
- Impl review W1-W3 → fixed after implementation (drift from the phases above, see `reviews/impl-review.md`):
  property groups inside `<Target>` are ignored; properties expand at definition time from the values defined so far;
  `'$(Name)' == ''` / `!= ''` conditions are decided, and a property that other conditions give different values is
  ambiguous, so a version using it stays `dependency-changed` with the values listed. `EvaluatedProperties` gained
  `ambiguous`.

## Progress

> `- [ ]` pending, `- [x]` done. A phase ends with ` — <commit sha>` on its done items. Never rename items.

### Phase 1: Property evaluation and reader

#### Automated
- [x] 1.1 Every listed case passes in `msbuild-properties.test.ts`, `readers.test.ts`, `classify.test.ts` — b1a0cd6
- [x] 1.2 Gates green (typecheck, lint, test) — b1a0cd6

### Phase 2: Layer wiring, end to end, README

#### Automated
- [x] 2.1 End-to-end cases pass in `test/e2e/dependencies.test.ts` — d6daf0f
- [x] 2.2 `npm run build` and `npm run test:pack` pass — d6daf0f
- [x] 2.3 Gates green (typecheck, lint, test) — d6daf0f
