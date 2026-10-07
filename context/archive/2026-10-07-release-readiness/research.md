# Research: release-readiness

Input: change.md, roadmap CMP-6. Depth: normal.
Snapshot: 5fab1de on claude/project-thread-q44ui9 (CMP-3 branch with CMP-4 and CMP-5 merged in), 2026-10-07 10:20 UTC.

## Summary
All five v1 layers are registered (`src/layers/registry.ts:9`) and each has its own e2e test with research
fixtures (`test/e2e/*.test.ts`), but no single run covers the whole PETSEO acceptance table. The CLI knows only
`check` (`src/main.ts:75`); there is no `init`. There is no README. CI (`.github/workflows/ci.yml`) already runs
typecheck, lint, tests with a real oasdiff, build and the pack test; there is no publish workflow.
`package.json:4` still says `"private": true`, which makes `npm publish` refuse, and the version is `0.0.0`.
`publishConfig` (access public, provenance) and the MIT licence are already in place. Everything the README needs
(config schemas, finding ids and classes, gate semantics) is in the layer `config.ts` and classify files listed below.

## Current state
- CLI entry `src/cli.ts:4` calls `main(argv, io)`; `src/main.ts:13` holds `USAGE`, `runMain` parses flags with
  `node:util.parseArgs` (`src/main.ts:43`) and accepts only the `check` positional (`src/main.ts:75-80`).
- `runCheck` (`src/commands/check.ts:47`) loads `compat.config.json` (`DEFAULT_CONFIG_FILE`,
  `src/config/config.ts:6`), refuses a config with no enabled layer (exit 2, `src/commands/check.ts:55`), opens two
  `RefTree`s and runs the enabled layers in registry order.
- Config schema: `buildConfigSchema` (`src/config/config.ts:13`) composes `{ $schema?, layers: { <name>?: layer
  schema + enabled? } }` from the registry; `enabled: false` turns a configured layer off (`src/config/config.ts:43`).
- `RefTree.listFiles(globs)` and `readFile(path)` (`src/git/ref-tree.ts:16-21`) list and read any commit; `HEAD`
  is a valid ref, so `init` can use the same code to look at the repository.
- Layer schemas, for the README reference:
  - `openapi`: `src/layers/openapi/config.ts:15` sources `file` | `command` (`run`, `output`, `timeoutSeconds`,
    default 600 s, `src/layers/openapi/spec-source.ts:8`) | `url` (`base`, `revision`); `accept` by oasdiff id and
    `operation`; `oasdiff.path`, `oasdiff.args`. The command runs with `cwd` = the materialised tree of each ref and
    `COMPAT_SIDE`, `COMPAT_REF`, `COMPAT_COMMIT` in the environment (`src/layers/openapi/spec-source.ts:66-72`).
    oasdiff levels map 3/2/1 to breaking/needs-action/safe (`src/layers/openapi/classify.ts:10`).
  - `sql-migrations`: `src/layers/sql-migrations/config.ts:47` sources `folder` (`path`, `include`, default
    `**/*.sql`) | `ef-script` (`path`, `historyTable`, default `__EFMigrationsHistory`), each with `name`,
    `dialect` (`postgres` | `sqlserver`) and `accept` (`id`, `migration`, `object?`, `reason`). 26 rule ids with
    classes in `RULE_CLASSES` (`src/layers/sql-migrations/rules.ts:12`), plus `migration-modified` and
    `migration-removed` (needs-action, `src/layers/sql-migrations/sql-migrations-layer.ts:84`).
  - `seed`: `src/layers/seed/config.ts:21` sources `{ name, dialect, files, accept? }`; 14 ids with classes in
    `src/layers/seed/classify.ts:8-22`.
  - `persisted-enums`: `src/layers/persisted-enums/config.ts:73` `{ sources, enums: named | discover, accept? }`;
    ids `enum-member-added` (rollback-risk), `-removed`, `-renamed`, `-renumbered` (breaking; a rename of an `int`
    enum is needs-action), `-unresolved` (needs-action), `enum-added` (safe), `enum-removed` (needs-action)
    (`src/layers/persisted-enums/compare-enums.ts:79-240`, `persisted-enums-layer.ts:416`).
  - `config`: `src/layers/config/config.ts:63` sources `compose` | `dotenv` (`valuesAreDefaults`) | `regex`
    (`pattern` with `(?<key>)`, `flags`, `comments`); accept by `key` + `id`; 5 ids with classes in
    `src/layers/config/classify.ts:39-45`.
- Gate: `FAIL_ON_VALUES` and `evaluateGate` (`src/model/gate.ts:3,23`); a skipped or failed layer fails the gate
  unless `--allow-incomplete`; exit codes 0/1/2 (`src/main.ts:31`).

## Affected surface
| Area | Files | Why |
| --- | --- | --- |
| CLI | `src/main.ts`, new `src/commands/init.ts` | `init` command and usage text |
| Package | `package.json` | drop `private`, first version, `homepage`/`bugs` |
| Docs | new `README.md` | quick start, CLI and config reference |
| CI | `.github/workflows/ci.yml`, new `.github/workflows/publish.yml` | gates on Node 22 and 24; tag-driven publish |
| Tests | new `test/e2e/acceptance.test.ts`, new `test/commands/init.test.ts`, `test/pack/pack.test.ts` | F1-F12 acceptance, `init`, packed CLI |

## Data
None. No database; fixtures are files committed under `test/fixtures/`.

## Tests
- `npm test` (vitest, `vitest.config.ts`), `npm run typecheck`, `npm run lint` (Biome), and
  `npm run build && npm run test:pack` (`vitest.pack.config.ts`, `test/pack/pack.test.ts`).
- Real oasdiff tests skip without the binary unless `COMPAT_REQUIRE_OASDIFF=1` (`test/helpers/oasdiff.ts:27`);
  in this container oasdiff v1.33.0 installs with `go install` (memory: proxy.golang.org works).
- Per-finding fixtures exist: F1/F2 `test/fixtures/openapi/f1-f2/`, F4/F5 `test/fixtures/sql-migrations/ef-*`,
  F6 `test/fixtures/seed/f6-*`, F7 inline in `test/e2e/persisted-enums.test.ts:10-37`, F10
  `test/fixtures/config/f10/`. Gap: no test runs all five layers in one check.
- The pack test runs only `--help` of the built CLI (`test/pack/pack.test.ts:34`); nothing runs `check` or `init`
  from `dist/`.

## Patterns to follow
- Commands: `runCheck(options, io)` returning an exit code, never throwing (`src/commands/check.ts:47`); `CheckIo`
  carries stdout, stderr, cwd and env; tests use `createIo` (`test/helpers/stub-layer.ts`).
- Errors are values: `Result` (`src/result.ts`); messages start with `softure-compat:` on stderr.
- E2E tests build git repos with `createRepo` and tags `2.2.4` / `2.3.4` (`test/helpers/git-repo.ts:14`).

## Prior work
- `context/archive/2026-10-07-backward-compat-checker/research.md` §1: the F1-F12 acceptance table; F3, F8, F9,
  F11, F12 belong to later layers (`context/backlog/later-layers.md`).
- `context/archive/2026-10-07-backward-compat-checker/change.md` Constraints: Distribution (npm, bin, Node >= 22,
  `publishConfig.access: public`, `provenance: true`, MIT, following `@softure-ai/skills`, whose `package.json`
  carries the same `publishConfig`).
- CMP-1 created `ci.yml` with oasdiff via `go install` (archived plan of backward-compat-checker).

## SOFTURE modules
Not applicable: a CLI command, documentation and CI workflows; no generic capability from `@softure-ai/*` applies,
and the change Constraints forbid depending on those packages.

## Risks
- Publishing cannot be exercised here (no token). Mitigation: the workflow verifies the tag against
  `package.json` and runs every gate before `npm publish`; the pack test runs the packed CLI.
- Provenance needs `id-token: write`, a public repository and `repository.url` matching the GitHub repository;
  `package.json:16-18` already points at `SOFTURE/COMPAT`.
- `init` heuristics could enable a layer whose source then fails (for example a compose glob matching nothing).
  Mitigation: enable a layer only when its inputs were found at `HEAD`; otherwise write it with `enabled: false`.
- The combined acceptance run is slow if it needs oasdiff; it follows the existing skip rule.

## Relevant lessons
`context/foundation/lessons.md` has no numbered lessons yet. Memory note from CMP-4 (scanners must fail on
unparsed declarations) does not apply: `init` writes a config, it does not classify.

## Answers to unknowns
- Roadmap Unknowns: none.
- Which acceptance findings are in scope? F1, F2, F4, F5, F6, F7, F10 (change.md Intent). F3, F8, F9, F11, F12
  need later layers and are documented as not covered.
- Can one synthetic repository host every fixture? Yes: the fixtures use disjoint paths
  (`api/`, `db/migrations.sql`, `db/seed.sql`, `PETSEO.*`, `deploy/`, `.env.example`, `VPS/`, `src/`).
- Does `npm publish` work today? No: `"private": true` (`package.json:4`).

## Open questions
- Version of the first release → decided (auto): `0.1.0`, a pre-1.0 line while the owner tries it on PETSEO.
- Token or trusted publishing → decided (auto): `NPM_TOKEN` secret, as the brief names it; trusted publishing
  needs the package to exist on npm first, so it is a later switch documented in the README.

## Decisions (auto)
- Depth normal: no data, no auth, no migration; the riskiest part (publish) cannot run here anyway.
