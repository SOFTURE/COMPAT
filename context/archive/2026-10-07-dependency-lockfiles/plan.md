# Plan: dependency-lockfiles

Input: change.md (CMP-10), research.md. Complexity: medium (new readers in `src/layers/dependencies/`, the layer
entry point, a config flag, README section).

## Goal
With a lockfile next to a manifest, `dependencies` compares resolved versions of direct dependencies and reports
`watch` packages that change transitively; without one it behaves as today.

Acceptance:
- `package.json` unchanged at `^4.1.0`, `package-lock.json` 4.1.0 → 4.9.0 → `dependency-upgraded` `safe`,
  message `4.1.0 → 4.9.0: minor upgrade; resolved from lockfile`, evidence on the lockfile line.
- a watched package present only transitively changes → finding with the watch class and `transitive` in the message.
- pnpm 6.x and 9.x lockfiles both resolve; an unknown `lockfileVersion` fails the layer naming the file.
- NuGet `packages.lock.json` resolves `Direct` entries and watched `Transitive`/`CentralTransitive` ones.

**Out of scope:** yarn lockfiles; transitive packages that are not watched; `npm-shrinkwrap.json`.

## Approach
Readers per lockfile format return direct lookups and watched entries; the layer pairs each manifest with its
lockfile, builds resolved declarations, and per package and ref compares resolved versions when there are any,
declared ones otherwise.

**Key decisions:**
| Decision | Choice | Why |
| --- | --- | --- |
| Pairing | npm: nearest `package-lock.json` or `pnpm-lock.yaml` in the manifest folder or above whose lockfile has an importer for that folder (`package-lock.json` wins in one folder); NuGet: `packages.lock.json` in the folder of a matched MSBuild file | npm workspaces keep one root lockfile; NuGet keeps one per project |
| Direct versions | npm: manifest names looked up in the lockfile importer (node resolution walk for `package-lock.json`); NuGet: `Direct` entries | the manifest already filters `sections` |
| Precedence | per package and ref, resolved versions replace declared ones | a CPM `Directory.Packages.props` and a per-project lockfile both describe the same package |
| Transitive | only names matching `watch` (all copies, all TFMs) | change.md constraint |
| Declaration | optional `resolution: "lockfile" | "transitive"` on `Declaration` | manifest readers (CMP-9's `read-nuget.ts`) stay untouched |
| Message | `; resolved from lockfile`, or `; transitive, resolved from lockfile` when no declaration of the package is direct | the manifest range did not change, the reader must know why there is a finding |
| Unsupported format | `package-lock.json` other than v1-v3, `pnpm-lock.yaml` other than 5.x/6.x/9.x, NuGet lockfile other than v1/v2, invalid JSON → layer `failed` naming the file | change.md: the unsupported one fails visibly |
| Opt-out | `lockfiles: false` on a source | escape hatch for an unsupported or broken lockfile |
| Evidence | lockfile `path:line` of the entry | that is where the version lives |

## Progress
- [x] Phase 1: readers (`read-package-lock.ts`, `read-pnpm-lock.ts`, `read-nuget-lock.ts`), pairing and precedence in the layer, config flag, message suffix
- [x] Phase 2: unit tests per reader, e2e for npm, pnpm and NuGet lockfiles, README section
- [x] Gates: typecheck, lint, test, build, test:pack
