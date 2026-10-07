# Plan: backward-compat-checker

Input: change.md, research.md. Complexity: medium (3 phases; a new codebase, one external binary, git plumbing).

## Goal
In any git repository that holds a `compat.config.json`, the owner runs

```
softure-compat check --base <ref> --revision <ref> [--config <path>] [--format md|json] [--output <file>]
                     [--fail-on breaking|rollback-risk|needs-action|never] [--allow-incomplete]
```

and gets a report with one verdict per enabled layer and every finding classified as `safe`, `needs-action`,
`rollback-risk` or `breaking`, each with evidence (ref, commit, path, line when known). The command exits `0` when
the gate passes, `1` when a non-accepted finding is at or above `--fail-on` or a layer could not give a verdict, and
`2` when it cannot run at all (bad arguments, invalid config, unknown ref). The first layer, `openapi`, compares one
spec per configured API between the two refs with oasdiff and reproduces research F1 (added endpoints → `safe`) and
F2 (`request-property-became-not-nullable` → `breaking`, turned into an accepted finding by an `accept` entry). A
missing oasdiff binary reads as `skipped`, never as `safe`. The core exposes the `Layer` interface, `RefTree`, the
finding model, the layer registry and the composed config schema that CMP-2 to CMP-5 plug into.

**Out of scope:** the `sql-migrations`, `seed`, `persisted-enums` and `config` layers (CMP-2 to CMP-5); README,
`init`, the npm publish workflow and the PETSEO end-to-end acceptance fixture (CMP-6); the later layers and a pinned
oasdiff download (`context/backlog/later-layers.md`); removing `"private": true` and bumping the version (CMP-6,
release is the owner's).

## Approach
**Starting point:** the repository holds only the SOFTURE workflow files, a `package.json` with `type: module`,
Node `>=22` and `@softure-ai/skills` as the single dev dependency (`package.json:1-17`), and
`context/workflow.json` with every gate set to `null`. Research §4 is the design input; research §2 shows oasdiff
as the only fit for the OpenAPI diff, distributed as a Go binary outside npm. oasdiff `changelog --format json`
(verified with v1.33.0 built by `go install`) prints an array of
`{ id, text, level (1 INFO, 2 WARN, 3 ERR), operation, operationId?, path, section, baseSource?, revisionSource? }`,
where `*Source` carries `{ file, line, column }`, and exits `0` regardless of the findings.

**Chosen:** a TypeScript CLI compiled with `tsc` to `dist/`, one runtime dependency (`zod`), argument parsing with
`node:util` `parseArgs`, git access through the `git` binary (`rev-parse`, `show`, `archive`), and oasdiff run as a
child process with `changelog --format json`. Each layer is a module with a zod config schema and a
`run(context)` function; the registry composes their schemas into the config schema.
Rejected: plain JavaScript with JSDoc types - AGENTS conventions ask for TypeScript with schemas at the boundary;
`commander`/`yargs` - one subcommand does not justify a dependency; oasdiff `breaking` plus a separate `changelog`
run - `changelog` already carries every level, one run is enough; a Docker fallback for oasdiff - adds a daemon
dependency and is listed in the backlog as the pinned-download alternative.

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Language and build | TypeScript, `tsc` to `dist/`, ESM, Node >= 22 | npm package with a `bin`; conventions require types and schemas | change, plan |
| Runtime dependencies | `zod` only | config is external data and is narrowed with a schema (AGENTS conventions) | plan |
| Dev tooling | `typescript`, `vitest`, `@biomejs/biome`, `@types/node` | one tool each for typecheck, test, lint+format; Biome is a single binary with no plugin tree | plan |
| Gates in `workflow.json` | `npm run typecheck`, `npm run lint`, `npm test` | the skills read gates from there; they are `null` today | plan |
| Config location | `compat.config.json` in the working tree root (`--repo`, default cwd), overridable by `--config` | the config describes how to check, and must work before it is committed at the base ref | plan |
| Config shape | `{ "layers": { "<layer>": { "enabled"?: boolean, ... } } }`; a layer runs when its key is present and `enabled` is not `false` | one entry per layer keeps CMP-2..5 to one registry line and one schema entry | research §4, roadmap |
| Unknown config keys | rejected (strict objects) with the zod path in the message | a typo must not silently disable a check | plan |
| Refs | resolved with `git rev-parse --verify --end-of-options <ref>^{commit}`; files listed with `git ls-tree -r -z --name-only` (git pathspecs, `:(glob)` magic for globs) and read with `git cat-file blob`; whole tree on demand with a temporary index (`GIT_INDEX_FILE=<tmp> git read-tree <commit>` + `git checkout-index -a --prefix=<dir>/`), cached per run, removed in `finally` | never builds in the consumer's working tree (research §4); unlike `git archive`, ignores `export-ignore`, needs no `tar` and touches no `.git/worktrees` | research |
| Classes and order | `safe` < `needs-action` < `rollback-risk` < `breaking` | research §4 and change Intent | research |
| oasdiff level mapping | ERR (3) → `breaking`, WARN (2) → `needs-action`, INFO (1) → `safe` | WARN covers deprecations and risky-but-legal changes the owner must know about | plan |
| Accept allowlist | per API `accept: [{ id, operation?, reason }]`, `operation` as `"POST /api/x/{id}"`; an entry without `operation` matches only changes that have no operation (an id-only entry can never hide the same check on another endpoint); an accepted finding keeps its class, is listed under "Accepted" with the reason, and never counts for the gate; notes list how many findings each entry accepted, and an entry that matched nothing is reported as unused | records reviewed false positives such as F2 without hiding them | research §4 |
| Spec sources | `file` (`path` in the ref), `command` (`run` in the materialised ref, then read `output`), `url` (`base` and `revision` URLs) | the three ways in research §4; `url` stays explicit opt-in, nothing defaults to a live server | research, change |
| Spec missing at one ref | missing at base and present at revision → `api-added` `safe`; present at base and missing at revision → `api-removed` `breaking`; missing at both → the layer fails with the path | an API added in the release is normal; a removed one breaks every old client | plan |
| Locating oasdiff | config `layers.openapi.oasdiff.path`, then env `SOFTURE_COMPAT_OASDIFF`, then `oasdiff` on `PATH`; probed with `--version` (reported as a note; a `go install` build prints `main`, so the note is informative, not a proof of the pin) | the binary is outside npm (research §2) | research |
| oasdiff extra args | `oasdiff.args` go before the fixed `--format json`; `--format`, `-f`, `--fail-on`, `-o` are rejected by the schema | the fixed output format must win; severities may still be tuned by the consumer on purpose | plan review S10 |
| Config strictness | every layer schema is a `z.strictObject` (including union variants), and `Layer.configSchema` is typed as a zod object | zod strips unknown nested keys by default; a typo such as `acept` must fail | plan review W5 |
| Path and URL safety | `file`/`output` paths must be relative, without `..`, and their `realpath` must stay under the tree root; URLs in messages are printed without user info and query | Markdown reports are posted to PRs; config paths must not read host files | plan review W8 |
| Missing oasdiff | layer status `skipped` with the install hint `go install github.com/oasdiff/oasdiff@v1.33.0` | never `safe` (roadmap risk) | roadmap |
| Exit codes | `0` pass; `1` gate failed (a non-accepted finding at or above `--fail-on`, or a `skipped`/`failed` layer without `--allow-incomplete`); `2` cannot run | the safer default: an incomplete check must not pass a CI gate silently | plan (WORKFLOW §8 safer option) |
| Default `--fail-on` | `breaking` | research §4 sketch | research |
| Reports | Markdown (default) and JSON with `schemaVersion: 1`, to stdout or `--output <file>`; diagnostics go to stderr | Markdown for release bodies and PR comments, JSON for tools | research §4 |
| CI | a minimal `.github/workflows/ci.yml` running the gates with oasdiff installed by `go install`; CMP-6 adds the publish workflow and the end-to-end acceptance fixture | the PR must have a green check, and every later layer needs the same gates | plan |
| Package metadata | `bin.softure-compat`, `files: ["dist"]`, `publishConfig: { access: public, provenance: true }`, `prepack` builds; `private: true` stays until CMP-6 | follows the SOFTURE npm conventions (change Constraints) without enabling a publish before release readiness | change, roadmap |

**Critical details:**
- oasdiff exits `0` even when it finds ERR changes; the layer must classify from the JSON, never from the exit code.
  A non-zero exit or unparseable output is a layer `failed`, never an empty list of findings.
- oasdiff reports `baseSource.file` / `revisionSource.file` as the absolute file that holds the change, which is
  a `$ref`-ed file when the spec is split; evidence makes the path relative to the materialised tree root of that
  side (so `api/schemas.yaml:15`), and uses the URL only for `url` sources.
- `command` sources run a shell command from the consumer's own config, inside a temp copy of each ref, with
  `COMPAT_SIDE` (`base`/`revision`), `COMPAT_REF` and `COMPAT_COMMIT` in the environment and a timeout
  (`timeoutSeconds`, default 600). Its output is captured, not streamed into the report; on failure the last
  20 lines of stderr go into the layer's failure message.

## Phase 1: Core command with the finding model, refs, reports and exit codes
**Discipline:** TDD. **Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`,
`biome.json`, `vitest.config.ts`, `context/workflow.json`, `src/result.ts`, `src/model/finding.ts`,
`src/model/gate.ts`, `src/process/run-process.ts`, `src/git/ref-tree.ts`, `src/layers/layer.ts`,
`src/layers/registry.ts`, `src/config/config.ts`, `src/report/markdown.ts`, `src/report/json.ts`,
`src/commands/check.ts`, `src/cli.ts`, `test/**`

1. Toolchain: add the dev dependencies and `zod`; scripts `build` (`tsc -p tsconfig.build.json`), `typecheck`
   (`tsc --noEmit`), `lint` (`biome check .`), `format` (`biome format --write .`), `test` (`vitest run`),
   `prepack` (`npm run build`). `tsconfig.json` is strict with `noUncheckedIndexedAccess`, `module`/`moduleResolution`
   `NodeNext`, target ES2023. Set the three gates in `context/workflow.json`.
2. `src/result.ts`: `Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E }` with `ok()` and `err()`.
   Expected failures across the code base are returned as values (AGENTS conventions).
3. `src/model/finding.ts`: `FINDING_CLASSES = ['safe', 'needs-action', 'rollback-risk', 'breaking']`,
   `compareClass(a, b)`, and the types. Contract (other layers depend on it):
   `Finding = { layer: string; scope: string; id: string; subject: string; class: FindingClass; message: string;
   evidence: Evidence[]; accepted?: { reason: string } }`,
   `Evidence = { side: 'base' | 'revision'; ref: string; commit: string; path: string; line?: number }`,
   `LayerResult = { layer; status: 'ran'; findings: Finding[]; notes: string[] } | { layer; status: 'skipped'; reason }
   | { layer; status: 'failed'; error }`. `notes` carries non-gating remarks (unused accept entries, tool versions).
4. `src/model/gate.ts`: `evaluateGate(results, { failOn, allowIncomplete })` returns
   `{ passed: boolean; exitCode: 0 | 1; reasons: string[] }` and `getLayerVerdict(result)` returns the highest
   non-accepted class, `skipped` or `failed`. `failOn: 'never'` ignores findings but not incompleteness.
5. `src/process/run-process.ts`: `runProcess({ command, args, cwd, env, timeoutMs?, shell? })` resolving to
   `{ exitCode, stdout, stderr }` or a typed `spawn-failed` (`ENOENT`) / `timed-out` error; never throws for a
   non-zero exit.
6. `src/git/ref-tree.ts`: `openRefTree({ repoDir, ref, side, tempRoot })` resolves the commit
   (`--end-of-options`) and returns `RefTree = { side; ref; commit; listFiles(pathspec: string | string[]):
   Promise<Result<string[]>>; readFile(path): Promise<Result<string | null>> (null when absent);
   materialize(): Promise<Result<string>> (dir under `tempRoot`, cached) }`. `listFiles` runs
   `git ls-tree -r -z --name-only <commit> -- <pathspecs>` (globs through `:(glob)` pathspec magic); `readFile`
   checks presence with `listFiles([path])` and reads with `git cat-file blob <commit>:<path>`, so "absent" and
   "git failed" are different results. `materialize` uses a temporary index file and `git checkout-index`, as in
   Key decisions. Later layers (migrations folders, enum and config files) use `listFiles` and `readFile` and never
   need to touch this file.
7. `src/layers/layer.ts`: `Layer<C> = { name: string; configSchema: ZodType<C>; run(context: LayerContext<C>):
   Promise<LayerResult> }`, `LayerContext<C> = { config: C; base: RefTree; revision: RefTree; repoDir: string;
   tempDir: string; env: NodeJS.ProcessEnv; log(message: string): void }`. `configSchema` is typed as a zod object
   so the core can add `enabled`; every layer builds it with `z.strictObject`. `tempDir` is a per-layer directory
   under the run's temp root, removed with it. `src/layers/registry.ts` exports `LAYERS` (empty in this
   phase); every later layer adds one line.
8. `src/config/config.ts`: `buildConfigSchema(layers)` composes `{ layers: { <name>: schema.extend({ enabled }) } }`
   as strict optional entries; `loadConfig(path, layers)` reads the file, parses JSON and returns
   `Result<CompatConfig>` with messages naming the file and the zod path (`layers.openapi.apis[0].source: ...`).
9. `src/report/json.ts` and `src/report/markdown.ts`: `renderJson(report)` and `renderMarkdown(report)` from
   `Report = { base: RefInfo; revision: RefInfo; failOn; gate; layers: LayerResult[] }`. Markdown: a title with
   both refs and short commits, the gate line (`PASS`/`FAIL` and why), a table `| Layer | Verdict | breaking |
   rollback-risk | needs-action | safe |`, then findings grouped by class from `breaking` down (each with scope,
   subject, message and evidence as `` `path:line` @ ref``), then "Accepted" with reasons, then notes, skipped and
   failed layers. Pipes and backticks in messages are escaped.
10. `src/commands/check.ts`: `runCheck(options, io): Promise<number>` - validates options, loads the config,
    rejects a config with no enabled layer (exit 2), creates one temp root (`fs.mkdtemp`), opens both trees, runs
    enabled layers in registry order (a thrown error inside a layer becomes `failed` with its message, so one layer
    cannot kill the report), renders, writes (a write failure is exit 2 with the path named), removes the temp root
    in `finally`, returns the exit code. `io = { stdout, stderr, cwd, env }` keeps it testable
    in-process.
11. `src/main.ts`: `main(argv, io): Promise<number>` with `parseArgs` for `check` and its options, `--help`,
    `--version` (from `package.json`); unknown command or option → usage on stderr and 2; any unexpected throw →
    one line on stderr (no stack) and 2, so a crash never reads as a failed gate. `src/cli.ts` is the `bin` entry:
    a shebang and `process.exitCode = await main(process.argv.slice(2), processIo)`, nothing else.

**Tests:** `finding.test.ts` (class order); `gate.test.ts` (no findings passes; `breaking` at `failOn: breaking`
fails; `needs-action` at `failOn: breaking` passes; accepted `breaking` passes; `failOn: never` with `breaking`
passes; skipped layer fails without `allowIncomplete`, passes with it; failed layer likewise); `config.test.ts`
(missing file, invalid JSON, unknown top-level key, unknown layer, a typo nested inside a layer, `enabled: false`,
valid config; messages name the file and path) using a stub layer; `ref-tree.test.ts` on a temp git repository built in the test (unknown ref is an
error naming the ref; `readFile` returns content, `null` for an absent path; `materialize` holds the files of that
commit, not of the working tree, including a path marked `export-ignore`; `listFiles` with a plain path and with a
`:(glob)` pattern; a ref starting with `-` is rejected as unknown, not parsed as an option); `markdown.test.ts` / `json.test.ts` (empty report,
mixed classes, accepted, skipped and failed layers, escaping); `check.test.ts` in-process with a stub layer
registered through an injectable layer list (exit 0, 1 and 2 paths; `--output` writes the file; `--output` to an unwritable path → 2; unknown ref → 2; the temp root is gone after
the run); `main.test.ts` (`--help` returns 0, unknown option returns 2, missing `--base` returns 2).

**Done when:**
- Automated: the named phase 1 tests pass (finding, gate, config, ref-tree, markdown, json, check, main).
- Automated: `runCheck` with a stub layer reporting a `breaking` finding returns 1, and 0 with `--fail-on never`.
- Automated: an unknown ref returns 2 and stderr names the ref; a config with no enabled layer returns 2.
- Automated: `context/workflow.json` gates are `npm run typecheck`, `npm run lint`, `npm test`.
- Automated: Gates green (typecheck, lint, test).

## Phase 2: The `openapi` layer with oasdiff, spec sources and the accept allowlist
**Discipline:** TDD. **Files:** `src/layers/openapi/config.ts`, `src/layers/openapi/spec-source.ts`,
`src/layers/openapi/oasdiff.ts`, `src/layers/openapi/classify.ts`, `src/layers/openapi/openapi-layer.ts`,
`src/layers/registry.ts`, `test/layers/openapi/**`, `test/fixtures/openapi/**`, `test/helpers/**`

1. `src/layers/openapi/config.ts`: zod schema. Contract:
   `{ apis: [{ name, source, accept?: [{ id, operation?, reason }] }] (min 1, unique names), oasdiff?: { path?,
   args?: string[] (no --format, -f, --fail-on, -o) } }`, all `z.strictObject`, `source` a discriminated union on `kind`: `{ kind: 'file', path }`,
   `{ kind: 'command', run, output, timeoutSeconds? }`, `{ kind: 'url', base, revision }`.
2. `src/layers/openapi/spec-source.ts`: `resolveSpec({ source, tree, tempDir, env })` returns
   `Result<{ status: 'found'; file: string; root: string | null; displayPath: string } | { status: 'absent';
   displayPath }>`, where `root` is the materialised tree (null for `url`) used to make evidence paths relative.
   Paths from the config pass the safety check in Key decisions before use.
   `file`: `tree.materialize()` and read `<tree>/<path>` there, so relative external `$ref`s next to the spec
   resolve (absent file → `absent`). `command`: `materialize()`, run with `shell: true`, cwd the temp tree, env plus
   `COMPAT_SIDE`, `COMPAT_REF`, `COMPAT_COMMIT`; non-zero exit, timeout or missing `output` → error with the last
   20 lines of stderr. A `command` source is never `absent`: the command decides what exists.
   `url`: `fetch` with `AbortSignal.timeout(30000)`, written under `tempDir`; non-2xx → error naming the redacted
   URL and the status.
3. `src/layers/openapi/oasdiff.ts`: `locateOasdiff({ configuredPath, env })` → `Result<{ path, version }>` (probe
   `--version`; `ENOENT` → not found); `runOasdiffChangelog({ binary, baseFile, revisionFile, args })` →
   `Result<OasdiffChange[]>`, user args placed before `changelog`'s fixed `--format json`, output parsed with a zod schema of the fields listed in Approach (unknown fields
   passed through), non-zero exit or invalid JSON → error with stderr.
4. `src/layers/openapi/classify.ts`: `classifyChanges({ api, changes, base, revision, baseSpec, revisionSpec })` →
   `Finding[]`; level mapping per Key decisions; `subject` = `"<operation> <path>"` (or `section` when no
   operation); evidence from `baseSource` / `revisionSource`, with the file made relative to that side's `root`
   (`displayPath` for `url`). `applyAccept(findings, accept)` → `{ findings, usage }` (match per Key decisions;
   `usage` counts the findings each entry accepted).
5. `src/layers/openapi/openapi-layer.ts`: `openapiLayer: Layer<OpenapiConfig>` - locate oasdiff (not found →
   `skipped` with the install hint), then per API resolve both specs, handle absent sides per Key decisions, run
   oasdiff, classify, apply accept; any API error → layer `failed` naming the API and the cause. Notes carry the
   oasdiff version, the accepted count per entry and every unused accept entry. Register it in `src/layers/registry.ts`.
6. `test/helpers/git-repo.ts`: builds a temp git repository with commits and tags from a map of files per commit.
   `test/helpers/fake-oasdiff.mjs`: a Node script that prints a canned JSON array or exits non-zero, selected by
   env, used as the configured oasdiff path to test the layer without the real binary.
7. Fixtures `test/fixtures/openapi/f1-f2/base.yaml` and `revision.yaml`: a medications API where `daysOfWeek`
   becomes not nullable (F2) and `GET /api/shop/items` and `GET /api/feature-flags` are added (F1).

**Tests:** config (each source kind valid; unknown `kind`; duplicate API names; empty `apis`; nested typo;
`args` with `--format` rejected); classify (each level; evidence path mapping for base and revision sources;
evidence in a `$ref`-ed file is reported as that file's repo path; change without operation); accept (id and
operation; operation mismatch keeps it; an entry for one operation does not hide the same id on another; id-only
entry matches only operation-less changes; unused entry reported); spec source (`file` present, absent, `../`
and absolute paths rejected, a symlink leaving the tree rejected; `command`
writes output and sees `COMPAT_SIDE`; `command` exits 1 → error with stderr tail; `command` without output file →
error; `url` via a local `node:http` server: 200, and 404 with a query token that does not appear in the error); layer with fake oasdiff (not found → skipped; non-zero
exit → failed; canned output → findings; absent at base → `api-added` safe; absent at revision → `api-removed`
breaking; absent at both → failed); real oasdiff on the F1/F2 fixture in a temp repo through `runCheck`: exit 1
with one `breaking` `request-property-became-not-nullable` on `POST /api/pets/{petId}/medications` and two `safe`
`endpoint-added`; with an accept entry for it: exit 0 and the finding listed as accepted. The real-oasdiff tests are
skipped when the binary is absent, unless `COMPAT_REQUIRE_OASDIFF=1`, which makes a missing binary fail them.

**Done when:**
- Automated: the named phase 2 tests pass (config, classify, accept, spec source, layer with fake oasdiff).
- Automated: with `COMPAT_REQUIRE_OASDIFF=1` and oasdiff installed, the F1/F2 end-to-end test exits 1 with one
  `breaking` `request-property-became-not-nullable` and two `safe` `endpoint-added`, and exits 0 with the accept
  entry.
- Automated: with oasdiff absent from `PATH`, `softure-compat check` on the same repository reports the `openapi`
  layer as `skipped` and exits 1 (0 with `--allow-incomplete`).
- Automated: Gates green (typecheck, lint, test).

## Phase 3: Packaging and CI
**Discipline:** test-after. **Files:** `package.json`, `.github/workflows/ci.yml`, `test/pack/pack.test.ts`

1. `package.json`: `bin: { "softure-compat": "dist/cli.js" }`, `files: ["dist"]`,
   `publishConfig: { access: "public", provenance: true }`, `keywords`, `"private": true` unchanged.
2. `.github/workflows/ci.yml`: on `pull_request` and on `push` to `master`, `concurrency` cancelling superseded
   runs, Node 22 via `actions/setup-node`, Go via `actions/setup-go`,
   `go install github.com/oasdiff/oasdiff@v1.33.0`, `npm ci`, then typecheck, lint, test with
   `COMPAT_REQUIRE_OASDIFF=1`, build, and a smoke run `node dist/cli.js --help`.
3. `test/pack/pack.test.ts`: fails when `dist/cli.js` is missing; `npm pack --dry-run --json --ignore-scripts`
   lists `dist/cli.js` and no `src/` or `test/` files; `dist/cli.js` starts with `#!/usr/bin/env node`. It is
   excluded from `npm test` and run by `npm run test:pack` after the build step.

**Tests:** the pack test above; the CI run itself on the pull request.

**Done when:**
- Automated: `npm run build` produces `dist/cli.js`; `node dist/cli.js --help` exits 0; `npm run test:pack` passes.
- Automated: the CI workflow is green on the pull request, including the real-oasdiff tests.
- Automated: Gates green (typecheck, lint, test).

## Risks and rollback
- oasdiff output format changes in a later version → the zod schema rejects it and the layer reports `failed` (not
  `safe`); CI pins v1.33.0. Rollback: none needed, the gate fails closed.
- Materialising a large repository is slow → once per ref, only when a source needs the tree; acceptable for v1.
- Submodules are not materialised and Git LFS files stay pointers → a spec inside either fails to parse and the
  layer reports `failed`, never `safe`.
- A `command` source can run anything the consumer configured → documented by CMP-6; it never runs unless the
  consumer wrote it into their config.
- Each phase is a separate commit on the change branch; reverting a phase commit restores the previous state. No
  data or schema changes.

## Decisions (auto)
- Complexity → medium (three phases, new code base; no split needed).
- Where does the config live → the working tree, `--config` overrides (works before the config is committed at the
  base ref).
- Should a skipped or failed layer fail the gate → yes by default, `--allow-incomplete` opts out (safer option).
- How to treat oasdiff WARN → `needs-action` (the owner must know about deprecations and risky changes, but they do
  not break old clients).
- Does an accepted finding change class → no, it keeps its class, is listed separately and does not gate.
- Add CI now although CMP-6 owns release readiness → yes, a minimal gates workflow; CMP-6 adds publish and the
  acceptance fixture on top.
- Lint tool → Biome (one dev dependency for lint and format).
- Test runner → Vitest (runs TypeScript without a build step).
- Keep `"private": true` → yes until CMP-6, so nothing can be published before release readiness.

## Progress

> `- [ ]` pending, `- [x]` done. A phase ends with ` — <commit sha>` on its done items. Never rename items.

### Phase 1: Core command with the finding model, refs, reports and exit codes

#### Automated
- [x] 1.1 Named phase 1 tests pass (finding, gate, config, ref-tree, markdown, json, check, main)
- [x] 1.2 `runCheck` with a stub `breaking` finding returns 1, and 0 with `--fail-on never`
- [x] 1.3 An unknown ref returns 2 and stderr names the ref; a config with no enabled layer returns 2
- [x] 1.4 `context/workflow.json` gates are `npm run typecheck`, `npm run lint`, `npm test`
- [x] 1.5 Gates green (typecheck, lint, test)

### Phase 2: The `openapi` layer with oasdiff, spec sources and the accept allowlist

#### Automated
- [ ] 2.1 Named phase 2 tests pass (config, classify, accept, spec source, layer with fake oasdiff)
- [ ] 2.2 With real oasdiff, the F1/F2 repository exits 1 with one `breaking` `request-property-became-not-nullable` and two `safe` `endpoint-added`, and exits 0 with the accept entry
- [ ] 2.3 Without oasdiff on `PATH`, the `openapi` layer is `skipped` and the command exits 1, or 0 with `--allow-incomplete`
- [ ] 2.4 Gates green (typecheck, lint, test)

### Phase 3: Packaging and CI

#### Automated
- [ ] 3.1 `npm run build` produces `dist/cli.js`, `node dist/cli.js --help` exits 0 and `npm run test:pack` passes
- [ ] 3.2 The CI workflow is green on the pull request, including the real-oasdiff tests
- [ ] 3.3 Gates green (typecheck, lint, test)
