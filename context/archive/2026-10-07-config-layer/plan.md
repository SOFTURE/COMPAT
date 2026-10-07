# Plan: config-layer

Input: change.md, research.md. Complexity: small-to-medium (2 phases; one new layer folder over the existing core,
no data, one shared registry line).

## Goal
With `layers.config` in `compat.config.json`, `softure-compat check` collects configuration keys from compose
files, `.env` example files and configured regex sources at both refs and reports, per key:

- a key new in the revision without a default → `needs-action` (`config-key-added-required`): the value or secret
  must exist in production before the deploy;
- a key new in the revision with a default → `safe` (`config-key-added-optional`);
- a key that had a default at the base and has none in the revision → `needs-action` (`config-key-default-removed`);
- a key whose default value changed → `safe` (`config-key-default-changed`);
- a key gone from the revision → `safe` (`config-key-removed`).

Each finding names the key, the sources that declare it, and evidence (`path:line` at the ref). Commented-out
declarations are ignored. Research F10 is reproduced end to end: new required `Shop__BaseUrl` and `Shop__ApiKey`
are `needs-action`, with evidence in a compose file and in an Ansible `assert` described by a regex source; a .NET
`required` settings member described by a second regex source is reported under its own key (`ShopBaseUrl`) until
key normalization lands (backlog).

**Out of scope:** reading real production values or secrets; parsing YAML, JSON or `appsettings*.json` structure;
key normalization across naming schemes (`Shop:BaseUrl` vs `Shop__BaseUrl`) (backlog); README and `init` content
for this layer (CMP-6); any change to the core, the reports or other layers.

## Approach
**Starting point:** a layer is a folder with a strict zod schema and `defineLayer({...})` plus one line in
`src/layers/registry.ts:5`; the config schema composes itself from the registry (`src/config/config.ts:14-23`).
`RefTree.listFiles(globs)` and `readFile(path)` give the files of each ref (`src/git/ref-tree.ts:96-109`). The only
runtime dependency is `zod` (research §Summary).

**Chosen:** text scanners per source kind that turn a file into key declarations `{ key, line, default }`
(`default: null` means none), an index of declarations per ref, and a pure classification over the two indexes.
Rejected: a YAML parser for compose files - a new dependency for no gain, because Compose interpolates the raw
text and only comments must be removed first; materializing the trees - `readFile` is enough and much cheaper;
requiredness aggregated over all sources of a key - a `.env` example that documents a key at both refs would mask a
default removed in compose (plan review C1), so each source is classified on its own and the verdicts are merged per
key.

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Config shape | `layers.config = { sources: Source[] (min 1), accept?: [{ key, id?, reason }] }`, all `z.strictObject` | mirrors the openapi layer; typos fail | research, plan |
| Source kinds | `compose { name?, files? }`, `dotenv { name?, files?, valuesAreDefaults? }`, `regex { name, files, pattern, flags?, comments? }`, discriminated on `kind` | the three kinds in change.md | change |
| Source names | optional for compose and dotenv (default: the kind), required for regex; unique after defaulting | names go into scope and notes; two regex sources must be told apart | plan |
| Default globs | compose: `**/{docker-compose,compose}{,.*}.{yml,yaml}`; dotenv: `**/.env.{example,sample,template,dist}` and `**/{example,sample}.env` | works without configuration in the common layouts | plan |
| Compose forms | `$VAR`, `${VAR}`, `${VAR:?e}`, `${VAR?e}` → no default; `${VAR:-d}`, `${VAR-d}` → default `d`; `${VAR:+a}`, `${VAR+a}` → default `""`; `$$` skipped; references nested inside another default → default `""` | Compose spec interpolation (research §Answers) | research, change |
| `.env` values | placeholders by default: every key is required; `valuesAreDefaults: true` makes a non-empty value a default | example values are more often placeholders than defaults | research (auto) |
| Regex sources | JavaScript `RegExp` with a named group `key` and an optional named group `default`; a match where `default` did not participate has no default; `flags` limited to `i`, `m`, `s`, `u`; the layer adds `g` | describes .NET `required` settings or Ansible asserts without code (change.md) | change |
| Comments | `compose` and `dotenv`: `hash`; `regex`: `comments: "none" (default) | "hash" | "slash"`; stripped by replacing comment characters with spaces so offsets and line numbers stay; `hash` is `#` at line start or after whitespace; `slash` is `//` to end of line and `/* */`; both ignore markers inside `"` or `'` strings (string state resets at each line end) | roadmap risk: commented-out lines; `http://x` inside a string is not a comment | roadmap, plan |
| Key identity | the exact captured string, case-sensitive, compared across all sources | env vars are case-sensitive on Linux; normalization goes to the backlog | plan |
| Classification | per key and per source: required at a ref when one of that source's declarations there has no default; the verdicts of all sources are merged per key: sources with the same finding id share one finding (scope = their names, sorted, joined by `, `), and only the ids of the most severe class are reported | one source cannot mask another (plan review C1); a documented default must not add a `safe` line next to a `needs-action` | plan review |
| `default-changed` | compares the sorted set of distinct defaults of the source at each ref | several declarations may carry defaults (plan review W4) | plan review |
| Values in reports | default values are never printed, only that a default exists or changed | defaults can be development secrets, and reports are posted to PRs | plan |
| Evidence | added-required → revision declarations without a default; added-optional → revision declarations; removed → base declarations; default-removed → base declarations and revision declarations without a default; default-changed → both sides; deduplicated by path and line, sorted by ordinal path then line, at most 5 per side | one key used in many places must not flood the report (plan review W4) | plan |
| Accept | `accept: [{ key, id, reason }]` with `id` required; usage counts and unused entries as notes | an entry for a new key must not later hide a removed default of the same key (plan review S7) | research, plan review |
| A source that cannot speak for the revision | the layer reports `failed` naming the source when: no file matches at either ref; files match at the base but none in the revision; a regex source finds no key at either ref. Other sources still classify | an empty or moved source must not read as "no new keys" (fail closed; plan review W2) | research risk, plan review |
| Notes | per source: key and file counts at both refs and the matched revision paths (at most 5) | makes a silent source and noisy default globs visible (plan review W2, S8) | plan review |
| A source that cannot be read (git error) | that source is dropped from both sides and the layer is `failed` | a source read at one ref only would invent added or removed keys | plan |
| Shared files | only `src/layers/registry.ts` (one import, one entry); `src/config/config.ts` untouched | CMP-2 and CMP-4 edit the registry in parallel (brief) | change, roadmap |

**Critical details:**
- Regex patterns come from the consumer's config. They are compiled once in the schema (`refine`), so an invalid
  pattern or one without `(?<key>...)` is a config error (exit 2) naming `layers.config.sources[i].pattern`, never a
  crash during the run. `matchAll` already advances past zero-length matches.
- Comment stripping must keep the text length, otherwise line numbers and regex offsets drift.

## Phase 1: Key declarations from compose, `.env` and regex sources, and the classification
**Discipline:** TDD. **Files:** `src/layers/config/comments.ts`, `src/layers/config/scan-compose.ts`,
`src/layers/config/scan-dotenv.ts`, `src/layers/config/scan-regex.ts`, `src/layers/config/classify.ts`,
`test/layers/config/*.test.ts`

1. `src/layers/config/comments.ts`: `stripComments(text, style: "none" | "hash" | "slash"): string` per Key
   decisions, and `createLineLocator(text): (index: number) => number` (1-based line of an offset, binary search
   over line starts).
2. `src/layers/config/scan-compose.ts`: `scanCompose(text): KeyDeclaration[]` over the `hash`-stripped text, forms
   per Key decisions. Contract: `KeyDeclaration = { key: string; line: number; default: string | null }`, exported
   from `classify.ts` and shared by all scanners. Braced names must match `[A-Za-z_][A-Za-z0-9_]*`; anything else
   (or an unterminated `${`) is skipped, not an error.
3. `src/layers/config/scan-dotenv.ts`: `scanDotenv(text, { valuesAreDefaults }): KeyDeclaration[]`: lines
   `KEY=value` with an optional `export ` prefix, key `[A-Za-z_][A-Za-z0-9_.-]*`, value unquoted from `"..."` or
   `'...'`; lines without `=` ignored.
4. `src/layers/config/scan-regex.ts`: `scanRegex(text, { regex: RegExp, comments }): KeyDeclaration[]`: strip
   comments, `matchAll`, `key` group trimmed (empty → skipped), `default` group per Key decisions.
5. `src/layers/config/classify.ts`: `KeyIndex = Map<string, SourcedDeclaration[]>` with
   `SourcedDeclaration = KeyDeclaration & { source: string; path: string }`;
   `classifyKeys({ base: KeyIndex, revision: KeyIndex, baseTree, revisionTree }): Finding[]` per Goal and the Key
   decisions Classification and Evidence (subject = the key, messages without values, evidence capped);
   `applyAccept(findings, accept)` → `{ findings, usage }` like `src/layers/openapi/classify.ts`. Findings sorted by
   key then id, so reports are stable. `CONFIG_LAYER = "config"`.

**Tests:** comments (`#` comment line; `#` after whitespace; `a#b` kept; `#` inside quotes kept; `//` and `/* */`
over two lines; `"http://x"` kept; length and newlines preserved); compose (each form; `$$VAR` skipped; unbraced
`$VAR`; nested default; commented line ignored; invalid `${1}` and unterminated `${A` skipped; line numbers);
dotenv (plain, `export`, quoted, empty value, comment lines, inline comment, `valuesAreDefaults` both ways);
regex (key only, key and default, default group not participating, comments stripped, empty key skipped, line
numbers, zero-length pattern does not hang); classify (each of the five findings; required at both refs and
optional at both refs with the same default → nothing; a default added → nothing; one key with the same verdict
from two sources → one finding with both scopes; sources that disagree → only the most severe; a default removed in
compose while `.env` documents the key at both refs → `config-key-default-removed`; evidence cap at 5 per side; no
default value appears in any message); accept (key and id; id mismatch keeps the finding; unused entry reported).
Comments also cover a backslash in YAML single quotes and before a line end.

**Done when:**
- Automated: the named phase 1 tests pass (comments, compose, dotenv, regex, classify, accept).
- Automated: no finding message produced by the classify tests contains a default value.
- Automated: Gates green (typecheck, lint, test).

## Phase 2: The `config` layer, its config schema and the F10 acceptance test
**Discipline:** TDD. **Files:** `src/layers/config/config.ts`, `src/layers/config/config-layer.ts`,
`src/layers/registry.ts`, `test/layers/config/config.test.ts`, `test/layers/config/config-layer.test.ts`,
`test/e2e/config.test.ts`, `test/fixtures/config/f10/**`

1. `src/layers/config/config.ts`: `configLayerConfigSchema` per Key decisions, with defaults applied by zod, a
   `refine` that compiles regex patterns and requires the `key` group, flags `^[imsu]*$`, unique source names after
   defaulting. Exported types `ConfigLayerConfig`, `ConfigSource`.
2. `src/layers/config/config-layer.ts`: `configLayer = defineLayer({ name: CONFIG_LAYER, ... })`. For each source:
   `listFiles(files)` at both refs, `readFile` each file, scan by kind into the side's `KeyIndex`; failures per Key
   decisions; then `classifyKeys`, `applyAccept`. Notes per Key decisions, and accept usage like openapi. Status `ran`, or `failed` with the joined errors and the findings made.
3. `src/layers/registry.ts`: add `configLayer` after `openapiLayer` (one import, one entry).
4. Fixture `test/fixtures/config/f10/`: base and revision versions of `docker-compose.yml`, `.env.example` (with
   `valuesAreDefaults: true`, and documenting `Logging__Level` and `Shop__TimeoutSeconds` too), an Ansible
   `roles/app/tasks/main.yml` with an `assert` block, and `ApiSettings.cs` read by a `slash` regex source. The
   revision adds `Shop__BaseUrl` and `Shop__ApiKey` without defaults (compose and assert), `ShopBaseUrl` and
   `ShopApiKey` as `required` members, `Shop__TimeoutSeconds` with a default, removes the default of
   `Logging__Level`, and keeps commented-out `${Legacy__Token}` and C# members.

**Tests:** config schema (each kind valid with defaults applied; unknown kind; nested typo; invalid regex; pattern
without `key`; bad flag `g`; duplicate names, including two unnamed compose sources; empty `sources`); layer in a
temp repository (a source matching no file at either ref → `failed` with the source name and still the findings of
the other sources; files at the base and none in the revision → `failed`; a regex source with no key at either
ref → `failed`; a git error at one ref → the source dropped; a file present only in the revision → its keys
reported as added; notes per source); end to
end through `main()` on the F10 fixture: exit 0 with the default `--fail-on breaking`; the report lists
`Shop__BaseUrl` and `Shop__ApiKey` as `needs-action` `config-key-added-required` with evidence in
`docker-compose.yml` and `roles/app/tasks/main.yml`, `Shop__TimeoutSeconds` as `safe`, `Logging__Level` as
`needs-action` `config-key-default-removed`, `ShopBaseUrl` and `ShopApiKey` as `needs-action` from the .NET
source, and nothing for the commented-out declarations; no default value appears in the Markdown or JSON report;
exit 1 with `--fail-on needs-action`; exit 0 at `--fail-on needs-action` with accept entries for every
`needs-action` key, listed as accepted.

**Done when:**
- Automated: the named phase 2 tests pass (config schema, layer, end to end).
- Automated: on the F10 repository, `check --fail-on needs-action` exits 1 with `Shop__BaseUrl` and `Shop__ApiKey`
  as `needs-action`, and exits 0 when every `needs-action` key is accepted.
- Automated: `src/layers/registry.ts` gains exactly one import and one array entry, and `src/config/config.ts` is
  unchanged (`git diff` against the branch base).
- Automated: Gates green (typecheck, lint, test).

## Risks and rollback
- Compose interpolates YAML values, not raw text: inside a `|` block scalar, ` # ${X}` is part of the value and the
  `hash` stripper hides it (a false negative); pass-through `environment: [KEY]` entries carry no `$` and are not
  seen. A regex source covers pass-through entries; both cases go to the backlog. C# verbatim strings with `//` can
  give false positives, which `accept` records.
- A consumer's regex with catastrophic backtracking makes the run slow → the pattern is their own config; noted for
  CMP-6 documentation.
- Two parallel changes edit `src/layers/registry.ts` → a one-line merge conflict, resolved by keeping both entries.
- Each phase is one commit; reverting the phase 2 commit removes the layer from the registry and leaves the pure
  functions unused. No data or schema changes.

## Decisions (auto)
- Complexity → small-to-medium with two phases (pure scanners first, wiring second).
- Findings per key or per source → per key; sources with the same verdict share one finding (one production setting).
- Removed key and changed default → reported as `safe` for visibility (research decision).
- Print default values → never (they may be secrets).
- Source matching no file at either ref → layer `failed` (fail closed).
- Key normalization across naming schemes → not in v1; a backlog entry in `context/backlog/later-layers.md` is
  added at archive time, with the compose block-scalar and pass-through gaps.
- Plan review C1 → per-source classification merged per key, most severe class only (Fix A, plus the
  most-severe rule so a documented default adds no noise).
- Impl review W1 → comparison units per file matched at both refs, plus one per source for files present at one
  ref only (a test compose file must not hide a new production secret; a renamed file still adds nothing).
- Impl review W3 and C1 → a source with keys at the base and none in the revision fails; a dotenv source with no key
  at either ref fails; CRLF lines are read like LF lines.
- Impl review W2 → regex patterns compile with the `d` flag so evidence names the line of the key.
- Plan review S7 → `id` required in accept entries (the CMP-1 openapi allowlist made the same call).
- Regex flavour → JavaScript `RegExp` with named groups `key` and `default`.

## Progress

> `- [ ]` pending, `- [x]` done. A phase ends with ` — <commit sha>` on its done items. Never rename items.

### Phase 1: Key declarations from compose, `.env` and regex sources, and the classification

#### Automated
- [x] 1.1 Named phase 1 tests pass (comments, compose, dotenv, regex, classify, accept) — 8814d7c
- [x] 1.2 No finding message produced by the classify tests contains a default value — 8814d7c
- [x] 1.3 Gates green (typecheck, lint, test) — 8814d7c

### Phase 2: The `config` layer, its config schema and the F10 acceptance test

#### Automated
- [x] 2.1 Named phase 2 tests pass (config schema, layer, end to end) — e364e28
- [x] 2.2 On the F10 repository, `check --fail-on needs-action` exits 1 with `Shop__BaseUrl` and `Shop__ApiKey` as `needs-action`, and exits 0 when every `needs-action` key is accepted — e364e28
- [x] 2.3 `src/layers/registry.ts` gains exactly one import and one array entry, and `src/config/config.ts` is unchanged — e364e28
- [x] 2.4 Gates green (typecheck, lint, test) — e364e28
