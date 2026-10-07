# Research: persisted-enums-layer

Input: change.md, roadmap CMP-4, archived research of backward-compat-checker (§4 layer 5, fixture F7). Depth: quick.
Snapshot: ef1589e on claude/project-thread-62yuez (CMP-1, PR #2), 2026-10-07 09:10 UTC.

## Summary
The core built by CMP-1 already gives a layer everything it needs: a strict zod config schema composed from the
registry, two `RefTree`s with `listFiles(globs)` and `readFile(path)`, the finding model with four classes and
evidence, and a gate that counts `failed` layers. The new layer is a pure text job: no external binary, no build.
It finds enum declarations in C# and TypeScript sources at both refs, parses their members (names, explicit and
implicit values, attributes and comments in between), and compares them per persisted enum with storage-aware
rules. The list of persisted enums comes from the config, by name or by discovery (glob + regex with a capture
group, PETSEO: `ConfigureEnum<T>` in the DbContext). F7 is the acceptance case: a member added to a string-stored
enum is `rollback-risk`, with the discovery site (`PetseoDbContext.cs:188`) as evidence.

## Current state
- Layer contract: `src/layers/layer.ts:20-33` (`Layer`, `defineLayer`), `LayerContext` with `base`, `revision`,
  `env`, `log`.
- Registry: `src/layers/registry.ts:5` (`LAYERS = [openapiLayer]`), one line per layer.
- Config composition: `src/config/config.ts:13-22` extends every layer schema with `enabled` under
  `layers.<name>`; strict objects reject unknown keys.
- Files at a ref: `src/git/ref-tree.ts:12-21`; `listFiles` filters one cached `git ls-tree`, `readFile` spawns one
  `git cat-file blob` per file and strips a UTF-8 BOM; UTF-16 is not decoded (`context/backlog/core.md`).
- Findings and gate: `src/model/finding.ts:1-36`; a `failed` result keeps its findings and notes.
- Accept allowlist precedent: `src/layers/openapi/classify.ts` (`applyAccept`) with usage notes for unused entries.

## Affected surface
| Area | Files | Why |
| --- | --- | --- |
| New layer | `src/layers/persisted-enums/*` | owned by this change (change.md Constraints) |
| Registry | `src/layers/registry.ts` | one import and one array entry |
| Tests | `test/layers/persisted-enums/*`, `test/e2e/persisted-enums.test.ts` | unit and acceptance (F7) |

`src/config/config.ts` needs no edit: the schema composes itself from the registry.

## Data
None in the database. Input data is source text: C# (`enum X : byte { [Attr] A = 1, B, }`) and TypeScript
(`export const enum X { A = "a", B = 1 << 2 }`) declarations.

## Tests
vitest; temp git repos with `test/helpers/git-repo.ts`; whole command through `main()` with `createIo`
(`test/e2e/openapi.test.ts`). Gates from `context/workflow.json`.

## Patterns to follow
- Layer module layout and failure handling: `src/layers/openapi/openapi-layer.ts:19-62` (each unit checked even
  when another fails; errors joined into one `failed` result that keeps the findings).
- Config: `z.strictObject`, relative-path refinement, discriminated unions (`src/layers/openapi/config.ts:5-24`).
- Results as values (`src/result.ts`).

## Prior work
- `context/archive/2026-10-07-backward-compat-checker/research.md` §4 layer 5 and F7: the classification rules.
- `context/archive/2026-10-07-backward-compat-checker/plan.md`: core contracts, accept allowlist semantics.

## SOFTURE modules
Not applicable: no `@softure-ai/*` module parses enums, and the package must not depend on other `@softure-ai`
packages (AGENTS.md).

## Risks
- Parser fooled by attributes, comments, strings with braces or commas → tokenise first (comments and strings are
  single tokens), split members at depth-0 commas. Likelihood medium, covered by tests.
- Many source files (thousands of `.cs`) → one `git cat-file` per file; read with bounded concurrency and parse only
  files that contain the word `enum`. Likelihood medium.
- Same enum name declared in several files → explicit `file` on the config entry; otherwise the enum fails with
  the candidate paths.
- What is persisted for a TypeScript string enum is its value, not its name; C# string storage
  (`HasConversion<string>`) persists the name. The key rule must follow this.

## Relevant lessons
None recorded (`context/foundation/lessons.md` is empty).

## Answers to unknowns
- Roadmap risk "enum bodies with attributes and comments" → tokenizer-based parser (above).
- Discovery source → glob + regex at both refs, union of the names (an enum dropped from the DbContext in the
  revision still has rows written by the base).
- Rename under int storage → the stored number keeps its row meaning only if the meaning did not change; the tool
  cannot know, so it is `needs-action` (decided in the plan).

## Open questions
None escalated. The design choices are recorded in plan.md.
