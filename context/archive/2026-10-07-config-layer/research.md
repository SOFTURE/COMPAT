# Research: config-layer

Input: change.md, roadmap CMP-5, research of backward-compat-checker (§1 F10, §4 layer 7). Depth: quick (one new
layer folder over an existing core; no data, auth or money).
Snapshot: ef1589e on claude/project-thread-h321jp (branched from claude/project-thread-62yuez, PR #2), 2026-10-07 11:06 CEST.

## Summary
The core from CMP-1 already gives a layer everything it needs: `RefTree.listFiles(globs)` and `readFile(path)` per
ref, a strict zod config schema per layer that the core composes into `compat.config.json`, and the finding model
with evidence (`path`, `line`). A `config` layer is a new folder `src/layers/config/` plus one registry line; the
config schema needs no edit because `buildConfigSchema` builds itself from the registry. No YAML parser is in the
dependency tree (runtime dependency is `zod` only), so compose interpolation must be scanned from text, which is
also what Compose itself does before parsing YAML. Every source kind (compose, dotenv, regex) reduces to "key
declarations with a line number and an optional default" per ref; the classification is a set comparison over
keys. Main risks: false positives from commented-out lines (roadmap risk) and a misconfigured source that matches
no file and silently reports nothing.

## Current state
- Layer contract: `Layer = { name, description, configSchema (z.ZodObject), run(context) }`,
  `LayerContext = { config, base, revision, repoDir, tempDir, env, log }` (`src/layers/layer.ts:5-26`);
  `defineLayer` erases the config type for the registry (`src/layers/layer.ts:32-34`).
- Registry: `export const LAYERS: Layer[] = [openapiLayer];` (`src/layers/registry.ts:5`).
- Config composition: each registered layer becomes an optional strict entry `layers.<name>` extended with
  `enabled` (`src/config/config.ts:14-23`). Adding a layer to `LAYERS` is enough to accept its config.
- Files per ref: `listFiles(globs)` filters one cached `git ls-tree --full-tree` listing with the own glob matcher
  (`src/git/ref-tree.ts:96-101`, `src/git/glob.ts:5-41`; supports `**`, `*`, `?`, `{a,b}`); `readFile` returns the
  UTF-8 text without BOM or `null` when absent (`src/git/ref-tree.ts:102-109`). Paths are repository-root relative.
- Findings: `Finding = { layer, scope, id, subject, class, message, evidence[], accepted? }`, `Evidence = { side,
  ref, commit, path, line? }`; `LayerResult` `ran | skipped | failed` where `failed` still carries findings and notes
  (`src/model/finding.ts:7-37`).
- Reports render `layer / scope`, `id`, `subject`, message and evidence generically (`src/report/markdown.ts:33`),
  so a new layer needs no report change.
- The openapi layer shows the accept pattern to mirror: per entry usage counts, unused entries as notes
  (`src/layers/openapi/openapi-layer.ts:131-143`, `src/layers/openapi/classify.ts`).

## Affected surface
| Area | Files | Why |
| --- | --- | --- |
| New layer | `src/layers/config/*` | config schema, source scanners, classification, layer |
| Registry | `src/layers/registry.ts` | one import and one array entry (shared with CMP-2, CMP-4) |
| Tests | `test/layers/config/*`, `test/e2e/config.test.ts`, `test/fixtures/config/*` | unit and end-to-end |
| Config schema | `src/config/config.ts` | no change needed (composed from the registry) |

## Data
None. The layer reads files from git objects only.

## Tests
Vitest (`npm test`), temp git repositories via `test/helpers/git-repo.ts:14-42`, in-process CLI runs via `main()`
and `createIo` (`test/e2e/openapi.test.ts`, `test/helpers/stub-layer.ts:36-52`). Gates from `workflow.json`:
typecheck, lint (Biome), test. No coverage exists for configuration keys today.

## Patterns to follow
- Strict schemas everywhere, discriminated union on `kind` for sources (`src/layers/openapi/config.ts:13-23`).
- Expected failures as `Result` values (`src/result.ts`), layer `failed` keeps findings found so far
  (`src/layers/openapi/openapi-layer.ts:40-60`).
- Layer name exported as a constant from the layer folder (`OPENAPI_LAYER` in `src/layers/openapi/classify.ts`).
- Notes for non-gating remarks such as unused accept entries.

## Prior work
- `context/archive/2026-10-07-backward-compat-checker/research.md` §1 F10 and §4 layer 7: "new keys in compose
  `${VAR}` and in required settings. A new required key without a default is `needs-action`".
- CMP-1 plan decisions: strict configs, fail closed (a layer that cannot give a verdict is not `safe`), accept
  entries keep their class and are listed separately.
- `context/backlog/core.md`: UTF-16 decoding is not done; irrelevant for compose/env files (UTF-8 in practice).

## SOFTURE modules
Not applicable: no generic capability (auth, mail, billing, ...) is involved; change.md forbids `@softure-ai/*`
dependencies.

## Risks
- Commented-out declarations read as keys → false `needs-action` (likely). Mitigation: strip comments per source
  kind while keeping line numbers, string-aware so `http://` in a string is not a comment.
- A source whose globs match no file at either ref reports nothing, which reads as "no new keys" (likely after a
  typo or a moved file). Mitigation: treat it as a failure of the layer, never as an empty result.
- Key naming differs between sources (`Shop__BaseUrl` as env var vs `Shop:BaseUrl` in .NET) → one key reported
  twice. Low impact: both are real; the regex source lets the owner capture the env-var form.
- Invalid regex in the config → crash. Mitigation: compile in the schema and reject with a path.
- Catastrophic regex backtracking on a big file: the pattern is the consumer's own; acceptable for v1.
- Collisions: CMP-2 and CMP-4 also add a registry line → trivial merge conflict in `src/layers/registry.ts`.

## Relevant lessons
None recorded (`context/foundation/lessons.md` has no entries).

## Answers to unknowns
- Roadmap unknowns: none listed.
- Compose interpolation forms (Compose spec, "Interpolation"): `$VAR`, `${VAR}` (unset → empty string with a
  warning), `${VAR:-default}` / `${VAR-default}` (default), `${VAR:?err}` / `${VAR?err}` (error when unset),
  `${VAR:+alt}` / `${VAR+alt}` (value only when set), `$$` escapes a dollar, nested `${A:-${B}}` is allowed.
- Is a YAML parser needed? No: interpolation applies to the raw text, and comments are the only YAML construct that
  must be removed first.
- How does `.env` example express required vs optional? It does not; values in examples are placeholders as often
  as defaults.
- Can the config schema stay untouched? Yes (`src/config/config.ts:14-23`).

## Open questions
- Does a value in a `.env` example count as a default? → decided (auto): no by default, opt in per source.
- Are nested references (`${A:-${B}}`) required? → decided (auto): `B` has a default (it is only read when `A` is
  unset, and an unset `B` yields an empty string).
- What about a removed key or a changed default? → decided (auto): reported as `safe` for visibility.

## Decisions (auto)
- Depth → quick (one new folder over the existing core, no data or security surface).
- `.env` example values → placeholders by default (`valuesAreDefaults: false`), so every new key there is required.
- Nested compose references → treated as having a default.
- Removed key, changed default → `safe` findings, for visibility in the report.
