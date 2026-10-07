# Research: dependency-lockfiles

## Today
`src/layers/dependencies/` reads manifests only. `parseVersion` reduces a range to its lower bound, so `^4.1.0`
in `package.json` reads as 4.1.0 whatever the lockfile installs. Packages that are not declared in a manifest never
appear. Each source (`nuget`, `npm`) lists its manifests with `files`, skips `node_modules`, `bin` and `obj`, and
produces `Declaration { ecosystem, name, version, path, line }`; `classifyPackages` compares per package over all
files of a ref. `read-nuget.ts` is owned by CMP-9 (`msbuild-properties`), so this change does not edit it.

## Lockfile formats
| File | Shape that matters |
| --- | --- |
| `package-lock.json` v2/v3 (npm 7+) | `packages` keyed by install path: `""` is the root, `apps/web` a workspace, `node_modules/x` and `apps/web/node_modules/x` installed copies with `version`; links have `link: true` and no version |
| `package-lock.json` v1 (npm 5/6) | `dependencies` keyed by name with `version`, nested `dependencies` for non-hoisted copies; no workspaces |
| `pnpm-lock.yaml` 5.x (pnpm 6/7) | `specifiers` + `dependencies: { name: 1.2.3_peer@1.0.0 }` at the top or under `importers.<dir>`; `packages` keys `/name/1.2.3_peer` |
| `pnpm-lock.yaml` 6.x (pnpm 8) | `dependencies: { name: { specifier, version: 1.2.3(peer@1.0.0) } }` at the top or under `importers`; `packages` keys `/name@1.2.3(peer)` |
| `pnpm-lock.yaml` 9.x (pnpm 9/10) | always `importers` (`.` for the root); `packages` keys `name@1.2.3`, `snapshots` keys with peers |
| NuGet `packages.lock.json` v1/v2 | `dependencies.<tfm>[/<rid>].<Name> = { type: Direct | Transitive | CentralTransitive | Project, requested?, resolved }`, one per project folder |

Workspace links (`link:`, `workspace:`) carry no version and keep the manifest declaration.

## Size
A large `package-lock.json` is a few MB. JSON lockfiles are parsed once (no streaming parser without a
dependency), but only direct names and `watch` matches are turned into declarations, and key offsets are collected
in one regex pass so line numbers do not rescan the file per package. `pnpm-lock.yaml` is read line by line with a
small indentation tracker that only records importer entries and `packages` keys; no YAML dependency is added.

## Verified false negatives
- `package.json` keeps `"express": "^4.1.0"`, `package-lock.json` moves 4.1.0 → 4.9.0: no finding today.
- A watched messaging client pulled in transitively (`amqplib` under a wrapper) moves 0.10.3 → 0.10.4: no finding
  today, though `watch` asks for `needs-action`.
- NuGet: `Npgsql 8.0.0` declared, the lockfile resolves 8.0.3 because another package needs it: no finding today.
