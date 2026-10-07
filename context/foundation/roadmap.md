---
project: "SOFTURE COMPAT"
roadmap: v1
version: 1
status: ready
prd_version: null
updated: 2026-10-07
---

# Roadmap v1: a publishable `softure-compat` with the five layers that would have saved the PETSEO session

> Run-wide orders, read by orchestrators (not parsed):
> - Push main branch: no
> - Archive roadmap: no
> - Release: no (the owner publishes to npm with his own token)
> - Parallelism: one thread per change, started by the project coordinator; an item starts once its
>   prerequisites are merged into `master`

Source: `context/archive/2026-10-07-backward-compat-checker/research.md` (no PRD; the research and the owner's
requests of 2026-10-07 are the product input). Scope of v1 follows research §6 question 4: `openapi`,
`sql-migrations`, `seed`, `persisted-enums` and `config`. The layers `client-usage`, `message-contracts` and
`behaviour` wait in `context/backlog/later-layers.md`.

## At a glance

| ID | Change | Outcome | Depends on | Mode | Status |
| --- | --- | --- | --- | --- | --- |
| **CMP-1** | `backward-compat-checker` | `softure-compat check` runs end to end with the finding model, git refs, reports, exit codes and the `openapi` layer | — | autonomous | done |
| **CMP-2** | `sql-migrations-layer` | new migrations of the revision are classified for Postgres and SQL Server | CMP-1 | autonomous | ready |
| **CMP-3** | `seed-layer` | seed scripts that run on every deploy are diffed and classified | CMP-2 | autonomous | ready |
| **CMP-4** | `persisted-enums-layer` | added, removed and renumbered members of persisted enums are classified | CMP-1 | autonomous | done |
| **CMP-5** | `config-layer` | new required configuration keys are reported as `needs-action` | CMP-1 | autonomous | ready |
| **CMP-6** | `release-readiness` | README, `init` command, CI, publish workflow and an end-to-end acceptance fixture | CMP-2, CMP-3, CMP-4, CMP-5 | autonomous | ready |

## Order
CMP-1 builds the core every layer plugs into, so it goes first. CMP-3 reuses the SQL statement splitter of CMP-2.
CMP-4 and CMP-5 only add a layer folder and a registry line each. CMP-6 closes the roadmap: it documents the
finished command set and proves the PETSEO acceptance table on a synthetic repository. Items run
as separate threads, one change each; CMP-4 and CMP-5 may run next to CMP-2. The shared hot files are the layer
registry and the config schema that CMP-1 creates; every later item adds one entry to each.

## Items

### CMP-1: Core CLI and the OpenAPI layer
- **Change ID:** `backward-compat-checker`
- **Status:** done
- **Outcome:** `softure-compat check --base <ref> --revision <ref>` reads `compat.config.json`, runs enabled
  layers on both refs, prints Markdown or JSON and exits non-zero at or above `--fail-on`. The `openapi` layer
  wraps oasdiff with an allowlist for reviewed false positives.
- **Prerequisites:** none.
- **Unknowns:** none left; research.md §4 is the design input.
- **Risk:** oasdiff is a Go binary outside npm; a missing binary must read as `skipped`, never as `safe`.
- **Baseline:** no tool; the PETSEO analysis was manual.
- **PRD refs:** research.md §1 F1, F2; §4 design sketch.

### CMP-2: SQL migrations layer
- **Change ID:** `sql-migrations-layer`
- **Status:** ready
- **Outcome:** migrations present in the revision and absent in the base (a folder of scripts or an EF idempotent
  script) are split into statements and classified by dialect-aware rules.
- **Prerequisites:** CMP-1.
- **Unknowns:** how EF idempotent scripts mark migration ids in each dialect.
- **Risk:** regex rules miss exotic DDL; unknown statements must stay silent rather than be called `breaking`.
- **Baseline:** research.md F4, F5.
- **PRD refs:** research.md §4 layer 3.

### CMP-3: Seed layer
- **Change ID:** `seed-layer`
- **Status:** ready
- **Outcome:** seed files are diffed statement by statement; destructive or overwriting statements are
  `needs-action`, new upserted rows are `safe`.
- **Prerequisites:** CMP-2 (statement splitter).
- **Unknowns:** none.
- **Risk:** multi-row `INSERT ... VALUES` diffs need tuple-level comparison.
- **Baseline:** research.md F6.
- **PRD refs:** research.md §4 layer 4.

### CMP-4: Persisted enums layer
- **Change ID:** `persisted-enums-layer`
- **Status:** done
- **Outcome:** C# and TypeScript enums named in the config (or discovered by a pattern such as
  `ConfigureEnum<T>`) are compared member by member with storage-aware classes.
- **Prerequisites:** CMP-1.
- **Unknowns:** none.
- **Risk:** enum bodies with attributes and comments; the parser must tolerate them.
- **Baseline:** research.md F7.
- **PRD refs:** research.md §4 layer 5.

### CMP-5: Configuration layer
- **Change ID:** `config-layer`
- **Status:** ready
- **Outcome:** keys from compose files, `.env` examples and configured regex sources are compared; a new key
  without a default is `needs-action`.
- **Prerequisites:** CMP-1.
- **Unknowns:** none.
- **Risk:** false positives from commented-out lines; comments are stripped per source kind.
- **Baseline:** research.md F10.
- **PRD refs:** research.md §4 layer 7.

### CMP-6: Release readiness
- **Change ID:** `release-readiness`
- **Status:** ready
- **Outcome:** README with a quick start and the config reference, `softure-compat init`, GitHub Actions for CI
  and npm publish with provenance, and an end-to-end test that reproduces the in-scope PETSEO findings.
- **Prerequisites:** CMP-2, CMP-3, CMP-4, CMP-5.
- **Unknowns:** none.
- **Risk:** the publish workflow cannot be exercised without the owner's npm token.
- **Baseline:** none.
- **PRD refs:** change.md Constraints (distribution).

## Before the next release

## Owner decisions and checks

## Done
- **CMP-1** `backward-compat-checker`: core CLI (config, `RefTree`, finding model, gate, Markdown/JSON reports, exit codes) and the `openapi` layer on oasdiff, with CI; archived in `archive/2026-10-07-backward-compat-checker/`
- **CMP-4** `persisted-enums-layer`: `persisted-enums` layer (C# and TypeScript enum parser, string and int storage rules, discovery by glob + regex, accept allowlist, F7 acceptance test); archived in `archive/2026-10-07-persisted-enums-layer/`
