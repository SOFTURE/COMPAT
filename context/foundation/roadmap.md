---
project: "SOFTURE COMPAT"
roadmap: v2
version: 1
status: ready
prd_version: null
updated: 2026-10-07
---

# Roadmap v2: close the known gaps of every layer and make `softure-compat` native to CI

> Run-wide orders, read by orchestrators (not parsed):
> - Push main branch: no
> - Archive roadmap: no
> - Release: yes, through CMP-18 (a version bump merged to `master`; `release.yml` publishes)
> - Parallelism: one thread per change, started by the project coordinator; an item starts once its
>   prerequisites are merged into `master`

Source: `context/backlog/later-layers.md` (every open entry on 2026-10-07), research §6 question 6
(`context/archive/2026-10-07-backward-compat-checker/research.md`) and the owner's request of 2026-10-07 to take the
rest of the backlog. No open GitHub issues on 2026-10-07. Roadmap v1 (CMP-1..CMP-6) and the issue wave #11..#23 are
done; v1 is archived in `foundation/archive/2026-10-07-roadmap-v1.md`.

Three themes:
1. **Layer gaps** (CMP-7..CMP-13, CMP-16): what each layer still misses or reads silently, from the backlog.
2. **CI native** (CMP-14, CMP-15): results where reviewers look (code scanning, a pull request comment, the job
   summary) instead of a Markdown file in the job log.
3. **One more contract adapter** (CMP-17): gRPC/protobuf, the contract kind left after OpenAPI and messages.

## At a glance

| ID | Change | Outcome | Depends on | Mode | Status |
| --- | --- | --- | --- | --- | --- |
| **CMP-7** | `seed-statement-coverage` | CTE writes, dynamic SQL, `COPY` and `BULK INSERT` in seed scripts are diffed or reported, never silent | — | autonomous | new |
| **CMP-8** | `squawk-postgres-pass` | optional Squawk lint of new Postgres migrations next to the own rules, with a pinned verified download | — | autonomous | new |
| **CMP-9** | `live-client-refs` | `client-usage` reads the live client versions from Sentry releases or a command instead of a static list | — | autonomous | new |
| **CMP-10** | `compose-scanning-gaps` | compose block scalars, pass-through `environment` entries and multi-line quoted scalars are read | — | autonomous | new |
| **CMP-11** | `dependency-lockfiles` | resolved and transitive versions from `packages.lock.json`, `package-lock.json`, `pnpm-lock.yaml` | — | autonomous | new |
| **CMP-12** | `msbuild-evaluation` | MSBuild `Condition` attributes and properties from imported props files are evaluated | — | autonomous | new |
| **CMP-13** | `message-contracts-apicompat` | optional precise mode: Microsoft.DotNet.ApiCompat on built contract assemblies | — | autonomous | new |
| **CMP-14** | `sarif-report` | `--format sarif` for GitHub code scanning and other SARIF viewers | — | autonomous | new |
| **CMP-15** | `github-action` | a composite GitHub Action: runs the check, writes the job summary, keeps one PR comment, uploads SARIF | CMP-14 | autonomous | new |
| **CMP-16** | `seed-key-columns` | a seed source can name the row key columns per table | CMP-7 | autonomous | new |
| **CMP-17** | `protobuf-layer` | new `protobuf` layer on `buf breaking`, downloaded pinned and verified | CMP-8 | autonomous | new |
| **CMP-18** | `release-0-3-0` | README and backlog brought up to date, version `0.3.0` released | CMP-7..CMP-17 | autonomous | new |

## Order
Wave 1 starts at once and runs in parallel: CMP-7, CMP-8, CMP-9, CMP-10, CMP-11, CMP-12, CMP-13, CMP-14 (eight
threads; `context/workflow.json` allows four worktrees per orchestrator, the coordinator may run more as threads).
Wave 2 starts as its prerequisite merges: CMP-15 after CMP-14 (it uploads the SARIF file), CMP-16 after CMP-7 (both
own `src/layers/seed/seed-statements.ts`), CMP-17 after CMP-8 (CMP-8 turns the oasdiff download into a shared
pinned-binary helper that `buf` reuses). CMP-18 goes last.

Shared hot files: `README.md` (every item edits its own layer section; merge conflicts are textual), the layer
registry (`src/layers/registry.ts`, only CMP-17 adds a line), `src/cli.ts` and `src/report/` (CMP-14 only; CMP-15
calls the CLI from outside). CMP-11 and CMP-12 both live in `src/layers/dependencies/` but in different readers
(lockfile readers are new files; CMP-12 owns `read-nuget.ts`).

## Items

### CMP-7: Seed statement coverage
- **Change ID:** `seed-statement-coverage`
- **Status:** new
- **Outcome:** CTE writes (`WITH ... INSERT/UPDATE/DELETE`) are diffed row by row like plain writes; dynamic SQL
  with a literal body (`EXEC(N'...')`, `EXEC sp_executesql N'...'`, `EXECUTE '...'` in a `DO` body) is unwrapped and
  read; `EXECUTE format(...)`, `COPY` and `BULK INSERT` are reported as `unreadable-write` `needs-action` instead of
  staying silent.
- **Prerequisites:** none.
- **Unknowns:** how far T-SQL quote doubling inside nested literals needs to go.
- **Risk:** unwrapping must keep line numbers for evidence.
- **Baseline:** backlog seed-layer entries (dynamic SQL, CTE writes); `src/layers/seed/seed-statements.ts`.

### CMP-8: Squawk pass for Postgres migrations
- **Change ID:** `squawk-postgres-pass`
- **Status:** new
- **Outcome:** a Postgres `sql-migrations` source with `squawk: true` (or an object with excluded rules) runs Squawk
  over the new migrations and adds its findings with rule ids prefixed `squawk:` and a class per rule; the own rules
  stay authoritative and a duplicate of an own finding is dropped. Squawk is downloaded pinned with checksums per OS
  and arch into the user cache, like oasdiff; `--no-download` and a missing binary make the pass `skipped`, never
  `safe`. The oasdiff download code becomes a shared pinned-binary helper.
- **Prerequisites:** none.
- **Unknowns:** Squawk's JSON output shape for the pinned version (must be verified in CI, as the backlog entry asks).
- **Risk:** Squawk rule names change between versions; the pin and a zod schema guard it.
- **Baseline:** backlog entry "optional Squawk pass"; research §4 layer 3.

### CMP-9: Live client refs from release data
- **Change ID:** `live-client-refs`
- **Status:** new
- **Outcome:** `clients[].refs` accepts `{ sentry: { org, project, environment?, days?, tag } }` (releases with
  sessions or events in the last `days`, mapped to git tags by a template such as `mobile-{version}`) and
  `{ command, tag }` (any command that prints one version per line). Token from `SENTRY_AUTH_TOKEN`, never logged. A
  source that returns nothing or a version without a tag fails the layer (fail closed).
- **Prerequisites:** none.
- **Unknowns:** which Sentry endpoint reports adoption per release without a paid plan.
- **Risk:** network in tests; the HTTP client gets a fake server like the GitHub resolvers.
- **Baseline:** research §6 question 6; backlog entry "read live client versions"; `src/layers/client-usage/client-refs.ts`.

### CMP-10: Compose scanning gaps
- **Change ID:** `compose-scanning-gaps`
- **Status:** new
- **Outcome:** the `config` layer reads `${VAR}` references inside YAML block scalars (`|`, `>`) even after ` #`,
  pass-through `environment: [KEY]` and `KEY` map entries without a value (required from the host), multi-line
  quoted scalars, and keeps a trailing comment out of a plain scalar that contains an apostrophe.
- **Prerequisites:** none.
- **Unknowns:** none.
- **Risk:** more keys may surface as new `needs-action` findings in existing setups; the README says so.
- **Baseline:** backlog config-layer entry; `context/archive/2026-10-07-config-layer/reviews/impl-review.md`.

### CMP-11: Dependency lockfiles
- **Change ID:** `dependency-lockfiles`
- **Status:** new
- **Outcome:** when a lockfile sits next to a manifest (`packages.lock.json`, `package-lock.json`,
  `pnpm-lock.yaml`), the `dependencies` layer compares resolved versions instead of range lower bounds and reports
  transitive changes of configured packages; without a lockfile it behaves as today.
- **Prerequisites:** none.
- **Unknowns:** pnpm lockfile v6 vs v9 shapes; YAML parsing without a new dependency or with a small one.
- **Risk:** lockfiles are large; read only the configured packages.
- **Baseline:** backlog dependencies-layer entry; `src/layers/dependencies/`.

### CMP-12: MSBuild evaluation
- **Change ID:** `msbuild-evaluation`
- **Status:** new
- **Outcome:** `$(Property)` resolves through `Directory.Build.props`, `Directory.Packages.props` and explicit
  `<Import>`s up the folder chain; `Condition` attributes with simple comparisons
  (`'$(TargetFramework)' == 'net8.0'`, `!=`, `and`, `or`) are evaluated per configured property set; an expression
  that cannot be evaluated stays `dependency-changed` with the reason.
- **Prerequisites:** none.
- **Unknowns:** none.
- **Risk:** MSBuild semantics are large; the evaluator handles a documented subset and fails visible.
- **Baseline:** backlog dependencies-layer entry; `src/layers/dependencies/read-nuget.ts`.

### CMP-13: ApiCompat mode for message contracts
- **Change ID:** `message-contracts-apicompat`
- **Status:** new
- **Outcome:** a `message-contracts` source may set `mode: "apicompat"` with a `build` command per ref and the
  assembly paths; the layer builds both refs in temporary worktrees, runs Microsoft.DotNet.ApiCompat and maps its
  diagnostics to findings, which also covers base types outside the sources. Without `dotnet` the source is
  `skipped`.
- **Prerequisites:** none.
- **Unknowns:** the ApiCompat package and command line for the current .NET SDK (tool vs MSBuild task).
- **Risk:** CI needs a .NET SDK for the acceptance test; tests skip visibly when it is missing locally.
- **Baseline:** backlog message-contracts entry; `context/archive/2026-10-07-message-contracts-layer/plan.md`.

### CMP-14: SARIF report
- **Change ID:** `sarif-report`
- **Status:** new
- **Outcome:** `--format sarif` writes SARIF 2.1.0: one rule per finding id, level from the class, locations from
  evidence (file and line on the revision side), accepted findings as suppressions with the reason.
- **Prerequisites:** none.
- **Unknowns:** none.
- **Risk:** findings without a file location; they anchor on the config file.
- **Baseline:** `src/report/`.

### CMP-15: GitHub Action
- **Change ID:** `github-action`
- **Status:** new
- **Outcome:** `action.yml` at the repository root (`uses: SOFTURE/COMPAT@v0`) runs `softure-compat check` with
  inputs for base, revision, fail-on and config, writes the Markdown report to `$GITHUB_STEP_SUMMARY`, creates or
  updates one pull request comment (found by a hidden marker), and optionally uploads SARIF for code scanning. The
  release workflow moves the `v0` major tag.
- **Prerequisites:** CMP-14.
- **Unknowns:** none.
- **Risk:** the action must pin the CLI version it was released with.
- **Baseline:** README "In CI".

### CMP-16: Seed key columns
- **Change ID:** `seed-key-columns`
- **Status:** new
- **Outcome:** a seed source accepts `keys: { "<table>": ["col", ...] }`; rows without a conflict target or
  `MERGE ... ON` pairs are keyed by those columns instead of the first column.
- **Prerequisites:** CMP-7 (same file).
- **Unknowns:** none.
- **Risk:** none known.
- **Baseline:** backlog seed-layer entry "row key falls back to the first column".

### CMP-17: Protobuf layer
- **Change ID:** `protobuf-layer`
- **Status:** new
- **Outcome:** a `protobuf` layer runs `buf breaking` between the refs for configured modules (`buf.yaml` or a
  folder of `.proto` files), with the `WIRE_JSON` rule set by default and an accept allowlist; `buf` is downloaded
  pinned and verified through the helper from CMP-8; `init` detects `buf.yaml`.
- **Prerequisites:** CMP-8 (pinned-binary helper).
- **Unknowns:** buf's JSON output for the pinned version.
- **Risk:** a missing binary must read as `skipped`, never `safe`.
- **Baseline:** none; the stack-agnostic adapter list in AGENTS.md.

### CMP-18: Release 0.3.0
- **Change ID:** `release-0-3-0`
- **Status:** new
- **Outcome:** README "What it does not check yet" and the layer table reflect v2, closed backlog entries are
  checked off, `package.json` goes to `0.3.0`, and the merge releases it through `release.yml`.
- **Prerequisites:** CMP-7..CMP-17.
- **Unknowns:** none.
- **Risk:** none known.
- **Baseline:** README "Releasing".

## Owner decisions and checks
- [ ] **CMP-9**: a Sentry auth token with `project:releases` read scope is needed to try the Sentry source on a real
  project (the tests use a fake server).
- [ ] **CMP-15**: after the first release with the action, the owner may list it on the GitHub Marketplace.

## Done
(nothing yet)
