---
project: "SOFTURE COMPAT"
roadmap: v2
version: 1
status: ready
prd_version: null
updated: 2026-10-07
---

# Roadmap v2: no silent false negatives in the shipped layers, and a report reviewers actually see

> Run-wide orders, read by orchestrators (not parsed):
> - Push main branch: no
> - Archive roadmap: no
> - Release: yes, through CMP-12 (a version bump merged to `master`; `release.yml` publishes)
> - Parallelism: one thread per change, started by the project coordinator; an item starts once its
>   prerequisites are merged into `master`

Source: every open entry of `context/backlog/later-layers.md` on 2026-10-07, research §6 question 6
(`context/archive/2026-10-07-backward-compat-checker/research.md`) and the owner's request of 2026-10-07 to take the
rest of the backlog, but only what makes sense. No open GitHub issues on 2026-10-07. Roadmap v1 (CMP-1..CMP-6) and
the issue wave #11..#23 are done; v1 is archived in `foundation/archive/2026-10-07-roadmap-v1.md`.

## How items were chosen
The tool's promise is that a release which passes the gate does not break what runs in production. So an entry
made the cut when it closes a **false negative**: a real change that today produces no finding at all, verified in
the code. Entries that only make findings more precise, reduce noise that errs on the safe side, or check
something other than backward compatibility were rejected (see "Rejected"). One item outside the backlog made it:
the GitHub Action, because `needs-action` findings do not fail the default gate and today end up in a file nobody
opens.

## At a glance

| ID | Change | Outcome | Depends on | Mode | Status |
| --- | --- | --- | --- | --- | --- |
| **CMP-7** | `seed-silent-writes` | seed writes inside dynamic SQL are diffed; `COPY` and unreadable dynamic SQL are reported instead of silent | — | autonomous | done |
| **CMP-8** | `compose-scanning-gaps` | compose block scalars, pass-through `environment` entries and multi-line scalars no longer hide required keys | — | autonomous | done |
| **CMP-9** | `msbuild-properties` | package versions held in properties of `Directory.Build.props` or imported files are compared | — | autonomous | new |
| **CMP-10** | `dependency-lockfiles` | resolved versions from lockfiles, so lockfile-only upgrades and watched transitive ones are reported | — | autonomous | done |
| **CMP-11** | `github-action` | composite GitHub Action: runs the check, writes the job summary, keeps one PR comment | — | autonomous | done |
| **CMP-12** | `release-0-3-0` | README and backlog brought up to date, version `0.3.0` released | CMP-7..CMP-11 | autonomous | new |

## Order
CMP-7..CMP-11 have no prerequisites and run in parallel (five threads). CMP-12 goes last.

Shared hot files: `README.md` (each item edits its own section; conflicts are textual). CMP-9 and CMP-10 both live in
`src/layers/dependencies/`: CMP-9 owns `read-nuget.ts`, CMP-10 adds new lockfile readers and touches the layer
entry point; whichever merges second merges `master` in. No item touches the layer registry.

## Items

### CMP-7: Seed silent writes
- **Change ID:** `seed-silent-writes`
- **Status:** done
- **Outcome:** dynamic SQL with a literal body (`EXEC(N'...')`, `EXEC sp_executesql N'...'`, `EXECUTE '...'` in a
  `DO` body) is unwrapped and diffed; `EXECUTE format(...)`, concatenated dynamic SQL and `COPY ... FROM` are
  `unreadable-write` `needs-action`.
- **Why it matters:** `seed-statements.ts` detects writes by keyword with literals masked, so a write inside
  `EXEC(N'...')` and every `COPY` produce no finding: a seed that overwrites production rows that way passes.
- **Prerequisites:** none.
- **Risk:** unwrapping must keep the outer file's line numbers for evidence.

### CMP-8: Compose scanning gaps
- **Change ID:** `compose-scanning-gaps`
- **Status:** done
- **Outcome:** `${VAR}` inside block scalars (also after ` #`), pass-through `environment: [KEY]` and valueless
  `KEY:` entries (required from the host), multi-line quoted scalars, apostrophes in plain scalars.
- **Why it matters:** each miss lets a release that needs a new production secret pass the gate; pass-through
  entries are a common compose idiom.
- **Prerequisites:** none.
- **Risk:** existing setups may see new `needs-action` findings after upgrading; the README says so.

### CMP-9: MSBuild properties
- **Change ID:** `msbuild-properties`
- **Status:** new
- **Outcome:** `$(Property)` in a package version resolves through the `Directory.Build.props` chain and explicit
  in-repository `<Import>`s, nearest definition winning.
- **Why it matters:** today it resolves only from the declaring file, so `Version="$(MassTransitVersion)"` with the
  value in `Directory.Build.props` is the same unresolved text at both refs and an upgrade produces no finding.
- **Prerequisites:** none.
- **Risk:** MSBuild semantics are large; unsupported imports fail visibly.

### CMP-10: Dependency lockfiles
- **Change ID:** `dependency-lockfiles`
- **Status:** done
- **Outcome:** with `package-lock.json`, `pnpm-lock.yaml` or NuGet `packages.lock.json` next to a manifest, direct
  dependencies compare by resolved version and `watch` packages are also reported when they change transitively.
- **Why it matters:** ranges compare by lower bound, so a lockfile-only upgrade (`^4.1.0` from 4.1.0 to 4.9.0) or a
  watched messaging client pulled in transitively changes the running code with no finding.
- **Prerequisites:** none.
- **Risk:** lockfile size and pnpm v6/v9 formats; only the needed packages are read.

### CMP-11: GitHub Action
- **Change ID:** `github-action`
- **Status:** done
- **Outcome:** `action.yml` at the root (`uses: SOFTURE/COMPAT@v0`) runs the check, writes the report to
  `$GITHUB_STEP_SUMMARY` and creates or updates one PR comment; `release.yml` moves the `v0` tag.
- **Why it matters:** `needs-action` findings (secrets, data preconditions) do not fail the default gate, so they
  must be in front of the person merging the release PR, not in a file inside the job.
- **Prerequisites:** none.
- **Risk:** the action must pin the CLI version it is released with.

### CMP-12: Release 0.3.0
- **Change ID:** `release-0-3-0`
- **Status:** new
- **Outcome:** README and `context/backlog/later-layers.md` reflect v2, `package.json` goes to `0.3.0`, the merge
  releases it.
- **Prerequisites:** CMP-7..CMP-11.

## Rejected
| Idea | Source | Why not |
| --- | --- | --- |
| Squawk pass for Postgres migrations | backlog | Its compatibility rules (rename, type change, required column) duplicate the own 26 rules; the rest is lock and downtime lint (`CONCURRENTLY`, `NOT VALID`), which is not backward compatibility. A second pinned binary to maintain for that is not worth it. |
| ApiCompat precise mode for message contracts | backlog | Needs a .NET SDK and a build of both refs in CI; it only adds base types declared outside the repository. The source parser already covers contracts in the repo. |
| Live client versions from Sentry or a store | backlog, research §6 q6 | A static `{ tags, since }` list that goes stale keeps too many builds live, which only keeps findings conservative, never a false `safe`. A vendor API and token for less noise is not justified until real noise shows up. |
| Row-level diff of CTE writes in seeds | backlog | Already reported as `unreadable-write` `needs-action`, so nothing is silent; row-level parsing is polish. |
| Seed key columns per table | backlog | Only matters when a seed's first column is not its key; seeds lead with the key, and no consumer has hit it. |
| MSBuild `Condition` evaluation | backlog | When conditions declare several versions of one package, the layer already compares them conservatively; evaluating MSBuild conditions is a large surface for no missed finding. Property resolution (the false negative) is CMP-9. |
| SARIF output for code scanning | considered for v2 | Code scanning alerts describe code at one ref; a compat finding is a judgement on a pair of refs, so alerts would open and close confusingly. The PR comment of CMP-11 covers visibility. |
| `protobuf` layer on `buf breaking` | considered for v2 | No consumer uses gRPC today, and AGENTS.md lists no gRPC adapter. Add it when a consumer needs it. |

## Done
- **CMP-11** `github-action`: composite `action.yml` (job summary, one PR comment by marker, gate last, CLI pinned to the release through `package.json`), CI self-test, `release.yml` moves the major tag; archived in `archive/2026-10-07-github-action/`
