# Plan: release-readiness

Input: change.md, research.md. Complexity: medium.

## Goal
A SOFTURE project can adopt `softure-compat` from the README alone; `softure-compat init` writes a starter
`compat.config.json` that `check` accepts; CI runs the gates on Node 22 and 24 with oasdiff; a tag `v<version>`
pushed by the owner publishes `@softure-ai/compat` to npm with provenance; and one end-to-end run over a synthetic
repository reproduces F1, F2, F4, F5, F6, F7 and F10 of the PETSEO acceptance table with their expected classes.

**Out of scope:** publishing, tagging or creating secrets (the owner does it); a JSON Schema file for the config;
new layers or rules (F3, F8, F9, F11, F12 stay in `context/backlog/later-layers.md`); npm trusted publishing (needs
the package to exist first; documented as a later switch).

## Approach
**Starting point:** five layers are registered (`src/layers/registry.ts:9`) and each has its own e2e test; the CLI
has only `check` (`src/main.ts:75`); no README; CI exists (`.github/workflows/ci.yml`); `package.json:4` is
`"private": true` at `0.0.0`.

**Chosen:** add `init` as a second command next to `check`, detect inputs from the committed files at `HEAD` through
`RefTree` (same code `check` reads with), write every layer (detected ones enabled, the rest `enabled: false` with an
example), validate the result with `parseConfig` before writing; one acceptance test that merges the existing
fixtures into one repository; a tag-driven publish workflow with `NPM_TOKEN`.
Rejected: `init` as an interactive wizard - CI and agents cannot answer prompts; an `init` that writes only detected
layers - a repository with nothing detected would get a config that `check` refuses with "no layer is enabled" and
no example to follow; publishing from `master` pushes - the owner wants to decide when a release happens.

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| First version | `0.1.0`, tag `v0.1.0` | pre-1.0 while the owner tries it on PETSEO | research |
| npm auth | `NPM_TOKEN` secret, `npm publish --provenance --access public` | brief names it; trusted publishing needs an existing package | research |
| What `init` reads | committed files at `HEAD` | `check` reads commits too; untracked files never reach a release | plan |
| Undetected layers | written with `enabled: false` and an example | config is valid and shows how to enable each layer | plan |
| Existing config | refuse without `--force` (exit 2) | never overwrite a curated config silently | plan |
| Publish safety | tag must equal `v` + `package.json` version and be on `master`; every gate runs before publish; manual dispatch is a dry run | a wrong tag cannot publish an unreviewed commit | plan |
| Prerelease tags | a version with `-` publishes under dist-tag `next` | `latest` stays on stable versions | plan |
| CI Node versions | 22 and 24 | `engines.node` is `>=22` | plan |

**Critical details:** `init` must never enable a source that matches no file: the `config` and `seed` layers fail
a source whose globs match nothing (research, memory compat-config-layer / compat-seed-layer), so every enabled
source lists exactly what was found. The acceptance repository keeps the fixtures' paths, because several
expectations pin evidence lines (F7 `PetseoDbContext.cs:188`, F10 `deploy/docker-compose.yml:7`).

## Phase 1: Acceptance run over all five layers
**Discipline:** test-after (characterises behaviour that already exists). **Files:** `test/e2e/acceptance.test.ts`

1. `test/e2e/acceptance.test.ts`: one `createRepo` with tags `2.2.4` and `2.3.4` holding the openapi F1/F2, EF
   Postgres F4/F5, Postgres seed F6, F7 DbContext and enum, and F10 config fixtures at the paths their own e2e tests
   use; one config enabling all five layers; one `check --format json` run. The F7 sources are moved into a small
   exported helper next to the existing test or duplicated inline; pick inline duplication of the two builders if the
   existing test does not export them (no change to the existing test).
2. The test holds the acceptance table as data: `{ id: "F1", layer, findingId, subject?, class }` per row, and
   asserts each row against the report, plus: every layer `ran`; F4 = every `sql-migrations` finding other than
   `insert-explicit-id` is `safe`; exit code 1 at the default gate with `openapi` as the only gate reason (F2 is
   breaking by contract); and, with F2 accepted as in the PETSEO decision, exit 0 at the default gate and 1 at
   `--fail-on rollback-risk` (F7).
3. It follows the real-oasdiff rule (`describe.skipIf(shouldSkipRealOasdiff(...))`), so CI always runs it.

**Tests:** the acceptance case above; the out-of-scope rows (F3, F8, F9, F11, F12) are listed in a comment with
the backlog file, not asserted.

**Done when:**
- Automated: `npx vitest run test/e2e/acceptance.test.ts` passes with oasdiff on PATH and asserts F1, F2, F4, F5,
  F6, F7, F10 with classes safe, breaking, safe, needs-action, safe, rollback-risk, needs-action, and the gate
  outcomes before and after accepting F2.
- Automated: Gates green (typecheck, lint, test).

## Phase 2: `softure-compat init`
**Discipline:** TDD. **Files:** `src/commands/init.ts`, `src/main.ts`, `test/commands/init.test.ts`,
`test/main.test.ts`

1. `src/commands/init.ts`: `runInit(options, io): Promise<number>` with `InitOptions = { repoDir?: string;
   configPath?: string; force: boolean }` and the `CheckIo` shape. Opens `RefTree` at `HEAD`; a repository without a
   commit is exit 2 with "commit first". Builds the config with pure `buildStarterConfig(tree)`:
   - `openapi`: every `**/{openapi,swagger}*.{json,yaml,yml}` as a `file` source, name from the file (or its folder
     when the file is named `openapi`/`swagger`), sanitised to `[A-Za-z0-9._-]` and made unique;
   - `sql-migrations`: every `.sql` file containing `__EFMigrationsHistory` as `ef-script`; every folder holding a
     drizzle `meta/_journal.json` whose `dialect` is `postgresql` or `pg` (older drizzle-kit) as `folder`; dialect of an SQL file is `sqlserver`
     when it has a `GO` batch line or `[dbo]`, else `postgres`;
   - `seed`: `.sql` files whose name contains `seed` (any case) and that are not migration sources, one source per
     dialect;
   - `persisted-enums`: `discover` over `**/*DbContext.cs` with `ConfigureEnum<(?<name>[\w.]+)>` and `storage:
     "string"`, enabled when some DbContext contains `ConfigureEnum<`;
   - `config`: `compose` and `dotenv` sources with the default globs, each only when it matches a file.
   Paths under `node_modules/`, `bin/`, `obj/` and `dist/` are ignored. A layer with nothing found is written with
   `enabled: false` and an example source.
2. Same file: validate with `parseConfig(config, LAYERS, path)`; failure is exit 2 naming the issue (a bug, never a
   user error). Refuse an existing target without `--force` (exit 2). Write JSON with two-space indent and a final
   newline; print one stderr line per layer (`enabled: <what was found>` or `disabled: <why>`) and the next command.
3. `src/main.ts`: `init` positional with `--repo`, `--config`, `--force`; `check`-only flags with `init` (and
   `--force` with `check`) are usage errors; `USAGE` lists both commands.

**Tests:** detection per layer (each on and off), name collisions, ignored folders, Postgres vs SQL Server
detection, drizzle journal with a MySQL dialect ignored, existing file without and with `--force`, repository without
commits, the written file passes `parseConfig`, `init` then `check` on the same repo returns 0 or 1 (never 2) for
a compose-only repository, `main` usage errors.

**Done when:**
- Automated: `npx vitest run test/commands/init.test.ts test/main.test.ts` passes with the cases above.
- Automated: Gates green (typecheck, lint, test).

## Phase 3: Package, CI and publish workflow
**Discipline:** test-after. **Files:** `package.json`, `package-lock.json`, `.github/workflows/ci.yml`,
`.github/workflows/publish.yml`, `test/pack/pack.test.ts`

1. `package.json`: drop `private`, version `0.1.0`, add `homepage` and `bugs`; keep `publishConfig`; regenerate the
   lockfile's root entry with `npm install --package-lock-only`.
2. `ci.yml`: matrix Node 22 and 24, everything else unchanged.
3. `publish.yml`: on `push` of tags `v*` and on `workflow_dispatch` (always a dry run); permissions `contents:
   read`, `id-token: write`; checks the tag equals `v` + version and the commit is on `origin/master`; installs
   oasdiff; runs `npm ci`, typecheck, lint, tests with `COMPAT_REQUIRE_OASDIFF=1`, build, `test:pack`; then
   `npm publish --provenance --access public` (`--tag next` for a prerelease) with `NODE_AUTH_TOKEN` from
   `secrets.NPM_TOKEN`.
4. `test/pack/pack.test.ts`: the pack includes `README.md` and `LICENSE`; the built CLI runs `init` and then
   `check` in a temporary repository with a compose file and exits 0.

**Done when:**
- Automated: `npm run build && npm run test:pack` passes.
- Automated: `actionlint` reports no issue in `.github/workflows/`.
- Automated: `npm publish --dry-run` succeeds locally (no token needed) and lists `dist/cli.js`, `README.md`.
- Automated: Gates green (typecheck, lint, test).
- Manual: the owner adds the `NPM_TOKEN` secret and pushes tag `v0.1.0`; the workflow publishes with provenance.

## Phase 4: README
**Discipline:** test-after. **Files:** `README.md`, `test/readme.test.ts`

1. `README.md`: what it answers; install (`npm i -D @softure-ai/compat`, oasdiff via `go install
   github.com/oasdiff/oasdiff@v1.33.0` or `oasdiff.path`); quick start (`init`, `check`); CLI reference (flags, exit
   codes, classes and `--fail-on`, `--allow-incomplete`); CI usage (GitHub Actions snippet with `fetch-depth: 0`);
   config reference per layer with finding ids and classes and `accept` entries; that `command` spec sources run
   inside both materialised refs with `COMPAT_SIDE`/`COMPAT_REF`/`COMPAT_COMMIT`; what it does not cover (F3, F8,
   F9, F11, F12, links to the backlog); releasing (for the maintainer: `NPM_TOKEN`, tag, dry run).
2. `test/readme.test.ts`: every registered layer has a README section, every finding id of `RULE_CLASSES`, the seed
   and config id lists and the enum ids appears in the README, and every CLI flag in `USAGE` appears; so the
   reference cannot silently drift.

**Done when:**
- Automated: `npx vitest run test/readme.test.ts` passes.
- Automated: Gates green (typecheck, lint, test).
- Manual: the owner can configure PETSEO from the README alone.

## Risks and rollback
- A publish with a wrong version or from a wrong commit → the tag and `master` checks stop the job before
  `npm publish`; a bad release is deprecated with `npm deprecate`, never unpublished after 72 h.
- `init` heuristics produce a source that fails `check` → only found files are enabled; tests cover each layer.
- Acceptance test flakiness from oasdiff → same skip/require rule as the existing real-oasdiff tests.
- Rollback: each phase is one commit; revert it. Removing `private` is harmless until a tag is pushed.

## Decisions (auto)
- Phase 3 drift: `README.md` does not exist until Phase 4, so the pack test asserts `LICENSE` in Phase 3 and
  `README.md` in Phase 4, and item 3.3 was checked for `dist/cli.js` and `LICENSE` (README re-checked in 4.4).
- Complexity → medium (four thin phases, no data, one new command).
- Interactive wizard for `init` → no (non-interactive; agents and CI run it).
- JSON Schema for `$schema` → out of scope (not in change.md; the README reference and the zod errors cover it).
- F7 builders → duplicate inline in the acceptance test rather than refactor the existing e2e test (keeps Phase 1
  test-only).

## Progress

> `- [ ]` pending, `- [x]` done. A phase ends with ` — <commit sha>` on its done items. Never rename items.

### Phase 1: Acceptance run over all five layers

#### Automated
- [x] 1.1 `npx vitest run test/e2e/acceptance.test.ts` passes with oasdiff on PATH and asserts F1, F2, F4, F5, F6, F7, F10 with their classes and the gate outcomes before and after accepting F2 — 6de5d4c
- [x] 1.2 Gates green (typecheck, lint, test) — 6de5d4c

### Phase 2: `softure-compat init`

#### Automated
- [x] 2.1 `npx vitest run test/commands/init.test.ts test/main.test.ts` passes with detection, overwrite, no-commit and init-then-check cases — 53011bb
- [x] 2.2 Gates green (typecheck, lint, test) — 53011bb

### Phase 3: Package, CI and publish workflow

#### Automated
- [x] 3.1 `npm run build && npm run test:pack` passes, including `init` and `check` from the built CLI — 8839dc6
- [x] 3.2 `actionlint` reports no issue in `.github/workflows/` — 8839dc6
- [x] 3.3 `npm publish --dry-run` succeeds and lists `dist/cli.js` and `README.md` — 8839dc6
- [x] 3.4 Gates green (typecheck, lint, test) — 8839dc6

#### Manual
- [ ] 3.5 The owner adds the `NPM_TOKEN` secret and pushes tag `v0.1.0`; the workflow publishes with provenance

### Phase 4: README

#### Automated
- [x] 4.1 `npx vitest run test/readme.test.ts` passes
- [x] 4.4 `npm publish --dry-run` and the pack test list `README.md`
- [x] 4.2 Gates green (typecheck, lint, test)

#### Manual
- [ ] 4.3 The owner can configure PETSEO from the README alone
