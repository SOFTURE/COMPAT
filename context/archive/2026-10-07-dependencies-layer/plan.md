# Plan: dependencies-layer

Input: change.md, issue #17. Complexity: medium (one new layer folder, one registry line, an `init` detector, a
README section).

## Goal
With `layers.dependencies` in `compat.config.json`, `check` reports per package:

| Id | Class |
| --- | --- |
| `dependency-added` | `safe` |
| `dependency-removed` | `safe` |
| `dependency-upgraded` | `safe` for patch and minor; `needs-action` for major, a minor of `0.x`, any change of `0.0.x` |
| `dependency-downgraded` | `needs-action` |
| `dependency-changed` | `needs-action`: the declared version changed but at least one side is not a version (`latest`, `$(Undefined)`, a git URL) |

Acceptance: a `Directory.Packages.props` fixture with `0.4.0 → 1.2.0` reports `dependency-upgraded`
`needs-action`, `3.1.0 → 3.2.0` reports `safe`, and a test package matched by `ignore` produces no finding.

**Out of scope:** lockfiles and resolved transitive versions (backlog); fetching release notes from the network;
MSBuild `Condition` evaluation and properties defined outside the declaring file.

## Approach
Text readers per ecosystem turn each file into declarations `{ ecosystem, name, version, line }`; declarations are
aggregated per package over all files of a ref, then a pure classification compares the two refs.

**Key decisions:**
| Decision | Choice | Why |
| --- | --- | --- |
| Config shape | `{ sources?, watch?, ignore?, accept? }`, all `z.strictObject` | issue #17 |
| Sources | `nuget { files? }` (default `**/*.{csproj,fsproj,vbproj,props,targets}`), `npm { files?, sections? }` (default `**/package.json`, `["dependencies"]`); default both | a CPM repo keeps versions in `.props`, a classic one in `.csproj` |
| MSBuild elements | `PackageVersion`, `PackageReference`, `GlobalPackageReference` with `Include` or `Update`; version from `VersionOverride`, `Version` attribute or child element; versionless references are skipped (the central file has the version); `$(Prop)` resolved from `PropertyGroup`s of the same file; XML comments blanked first | covers central package management and classic projects without an XML dependency |
| Package identity | ecosystem + name; NuGet names case-insensitive | NuGet ids are case-insensitive |
| Several versions of one package at a ref | compared by lowest and highest: a lower bound or top that went down is a downgrade (wins), else an upgrade from the lowest base to the highest revision version | one project moving to another major must not hide behind another project already on it |
| Version parsing | the first `major[.minor[.patch[.rev]]][-pre]` in the declared text (`^1.2.3`, `[1.2,2.0)`, `1.x`); `*`, `latest`, URLs, `workspace:` are not versions | ranges compare by their lower bound |
| `watch` | `{ name: glob, class?, releaseNotes? }`; raises (never lowers) the class of every finding of a matching package; `releaseNotes` URL is printed in the message | issue #17: no network by default |
| `ignore` | name globs, case-insensitive; matched packages give no finding, counted in a note | analyzers, test packages |
| `accept` | `{ id, name, reason }`, unused entries reported as notes | as in other layers |
| Fail closed | no dependency file at either ref, or a file that cannot be read or parsed → `failed` | an empty scan must not read as "no upgrades" |
| Evidence | declaration `path:line` per side, at most 5 per side | as in the config layer |

## Progress
- [x] Phase 1: config schema, readers, versions, classification, layer, registry line
- [x] Phase 2: unit and e2e tests, `init` detector, README section, README test
- [x] Gates: typecheck, lint, test, build, test:pack
