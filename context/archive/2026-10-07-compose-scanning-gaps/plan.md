# Plan: compose-scanning-gaps

Input: change.md, roadmap v2 CMP-8, config-layer impl review S1. Complexity: medium (1 phase; layer-local).

## Goal
- `${VAR}` inside a block scalar (`|`, `>`) is read, also after ` #` (a `#` there is text, not a comment).
- Pass-through `environment` entries (`- KEY`, `[KEY]`, `KEY:`, `KEY: ~`, `{KEY: }`) are keys required from the host.
- A multi-line quoted scalar keeps its references, also on continuation lines starting with `#`.
- An apostrophe inside a plain scalar no longer keeps a trailing comment.
- README says more keys may surface after upgrading.

**Out of scope:** `env_file` contents, build `args` pass-through, full YAML (merge keys outside `environment`,
explicit indentation indicators, tabs as indentation).

## Research (summary)
- `scan-compose.ts` blanks comments with the generic `stripComments(text, "hash")` from `comments.ts`, which the
  dotenv, regex and message-contracts readers share. It knows quotes per line only: a quote opens anywhere (so
  `it's` opens a string) and closes at the line end (so a continuation line of a quoted scalar is plain text), and it
  has no notion of block scalars (so `# ${X}` inside `|` content is blanked).
- Compose interpolates every string value, block scalars included; `$$` escapes. Pass-through entries take the value
  from the shell (or the `.env` used for interpolation); when unset the variable is silently missing in the
  container, which is the failure the layer exists to catch.
- `classifyInUnit` treats a key as required at a ref when any declaration has `default: null`, so emitting a
  pass-through entry as `{ key, line, default: null }` needs no change in classification. Duplicate evidence lines are
  merged by `toEvidence`.
- A YAML library (e.g. `yaml`) would parse structure but loses nothing we need only if we also keep offsets for line
  numbers and reproduce Compose interpolation per scalar; the gaps are lexical (comment, quote and block-scalar
  boundaries) plus one shallow structural read of `environment`. A hand lexer holds; no dependency.

## Key decisions
| Decision | Choice | Why |
| --- | --- | --- |
| Comment masking | new YAML-aware `maskYamlComments` in `src/layers/config/yaml-text.ts`, used by compose only | the shared `stripComments` serves non-YAML formats; changing it would shift their behaviour |
| Quote opening | a quote opens only at the start of a token (after indent, `- `, `? `, `: `, `[`, `{`, `,`, tags and anchors) | YAML rule; `it's` in a plain scalar stays text |
| Quoted scalars | span lines; `\` escapes in `"`, `''` in `'` | YAML rule; continuation lines are not structure |
| Block scalars | header `|` / `>` at a token start; content = following lines that are blank or indented deeper than the node that owns the header (the key, or the `-`) | YAML rule without indentation indicators, which compose files do not use |
| Pass-through keys | entries of any `environment` node: block or flow sequence items without `=`, mapping keys with an empty, `~` or `null` value | the compose idioms; required (`default: null`) because the host must supply them |
| Aliases | `environment: *name` and `<<: *name` / `<<: [*a, *b]` inside an `environment` mapping resolve to the anchored node | `x-common-env: &env` plus merge is the usual way to share environments |
| Line | the entry's own line (the anchored entry's line for aliases) | evidence points at the declaration |
| Structure scope | any key named `environment` in a structural line | compose has no other `environment` key; an extension field with that name is a fail-closed false positive |

## Steps (phase 1)
1. `yaml-text.ts`: `maskYamlComments(text)` returns `{ text, scalarLines }`; `scalarLines` holds 0-based indexes of
   lines that start inside a block or quoted scalar. Tests: block scalars (`|`, `>-`, `- |`, `key: | # note`),
   ` #` inside block content, end of block on dedent, blank lines inside, multi-line `"` and `'` scalars with `#`
   continuations, escapes, apostrophes in plain scalars, quoted keys, flow collections, CRLF.
2. `compose-environment.ts`: `findPassThroughKeys(masked)` with anchors and merges. Tests: every entry form, entries
   with `=` and `$` skipped, nested values skipped, compact sequence at the key's indent, aliases, cycle guard,
   block-scalar content that looks like `environment:` ignored.
3. `scan-compose.ts` uses both; existing tests stay green; new scanner tests for each gap from the change.
4. Layer test: a release adding a pass-through entry yields `config-key-added-required`.
5. README compose row and an upgrade note; backlog entry closed.

## Progress
- [x] Phase 1 steps 1-5 (yaml-text.ts, compose-environment.ts, scan-compose.ts, layer test, README)
- [x] Impl review: PASS (reviews/impl-review.md)
