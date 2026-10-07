# Plan: check-defaults

Input: change.md, issue #42. Complexity: small (1 phase; config, CLI, check, init, report, action, README).

## Goal
- `compat.config.json` with `"check": { "base": "github-deployment:prod", "revision": "github-deployment:dev",
  "failOn": "breaking" }` makes `softure-compat check` run with no flags.
- `--base`, `--revision` and `--fail-on` override the config values one by one.
- A `base` or `revision` set neither in the config nor on the command line is exit code 2, naming both places.
- `init` writes `check`: the two GitHub environments with the most recent successful deployments, or `latest-tag`
  and `HEAD` when there are none or GitHub cannot be read.
- The report header says where each ref came from: `(config)` or `(--base)` / `(--revision)`; JSON carries `source`.

## Research (summary)
- `main.ts` rejects a missing `--base`/`--revision` before the config is read; the check must move into `runCheck`,
  after `loadConfig`, so the config can supply them. `--fail-on` gets its `breaking` default the same way.
- `parseConfig` uses a strict root schema, so `check` must be added there; unknown keys inside it stay errors.
- `init` already builds the config object and validates it with `parseConfig`; `check` slots in before `layers`.
- The GitHub client (`getGitHubContext`, `getRepoJson`) is reusable for listing deployments; `io.fetch` already
  lets tests inject a fake GitHub (`test/helpers/fake-github.ts`).
- The action (CMP-11) is not released yet (0.2.0 predates it), so its `base`/`revision`/`fail-on` inputs can become
  optional without breaking anyone.

## Key decisions
| Decision | Choice | Why |
| --- | --- | --- |
| Config shape | optional strict `check: { base?, revision?, failOn? }`, non-empty strings, `failOn` from `FAIL_ON_VALUES` | matches the issue; strict keeps typos visible |
| Precedence | flag, then config, then (`failOn` only) `breaking` | flags are the per-run override |
| Missing ref | exit 2 after the config is read: "no base ref: pass --base or set check.base in <file>" | the issue keeps exit 2; the message names both fixes |
| Ref source | `RefInfo.source: "config" \| "flag"`; Markdown `(config)` / `(--base)` after the ref | the reader sees whether a flag overrode the pinned value |
| init guess, two envs | an environment named like `prod` is the base; otherwise the less recently deployed one | production deploys less often than pre-release environments |
| init guess, one env | base that environment, revision `HEAD` | the only environment is the one to protect |
| init guess, none / GitHub unreadable | base `latest-tag`, revision `HEAD`, reason printed | the issue's fallback; `init` never fails because GitHub is unreachable |
| init cost | deployments newest first (one page of 100), one status call per deployment until two environments are found | bounded API use for a one-time command |
| Action inputs | `base`, `revision`, `fail-on` default to empty and are passed only when set | the config supplies them; a flag still overrides |

## Progress

> `- [ ]` pending, `- [x]` done.

### Phase 1: check defaults

#### Automated
- [x] 1.1 `config.test.ts`: `check` parsed (all keys optional), unknown key and bad `failOn` rejected
- [x] 1.2 `check.test.ts` + `main.test.ts`: no flags uses the config; flags override; missing base or revision is exit 2; usage no longer says required
- [x] 1.3 `report.test.ts`: header shows `(config)` and `(--base)`; JSON `source`
- [x] 1.4 `init.test.ts`: two environments (prod named, and by recency), one environment, no deployments, GitHub unreadable
- [x] 1.5 Action inputs optional; README documents `check`, the header source and the action defaults; gates green
