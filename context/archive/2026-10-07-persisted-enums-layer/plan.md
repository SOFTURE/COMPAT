# Plan: persisted-enums-layer

Input: change.md, research.md. Complexity: medium (2 phases; one new layer, a hand-written parser, no external tool).

## Goal
With `layers["persisted-enums"]` in `compat.config.json`, `softure-compat check` compares every persisted enum
between the two refs member by member. Under `string` storage a removed or renamed member is `breaking` and an
added member is `rollback-risk`; under `int` storage a removed or renumbered member is `breaking`, an added value
is `rollback-risk`, and a value that keeps its number under a new name is `needs-action`. The enum list comes from
named entries and from discovery (file glob + regex with a capture group). Declarations are parsed from C# and
TypeScript, tolerating attributes, comments, explicit values, expressions and implicit numbering. Research F7
(`NotificationType.TermsChange` added to a string-stored enum discovered through `ConfigureEnum<T>`) yields one
`rollback-risk` finding whose evidence names the member line and the discovery site; with `--fail-on rollback-risk`
the command exits `1`, and `0` with an `accept` entry (the default `--fail-on breaking` passes it).

**Out of scope:** detecting a storage change (string ↔ int) between the refs, which is a migration concern
(CMP-2); database-native enums (Postgres `CREATE TYPE ... AS ENUM`, drizzle `pgEnum`), which belong to the
migrations layer; TypeScript `as const` objects and union types; UTF-16 sources (core backlog); README and
`init` (CMP-6).

## Approach
**Starting point:** the core (CMP-1) composes the config schema from `LAYERS` (`src/config/config.ts:13-22`), gives
each layer two `RefTree`s with `listFiles` and `readFile` (`src/git/ref-tree.ts:12-21`), and gates on findings and
on `failed` results (`src/model/finding.ts:30-35`). Nothing parses source code yet.

**Chosen:** a self-contained layer in `src/layers/persisted-enums/`: a small tokenizer shared by C# and TypeScript,
an enum parser on top of it with a BigInt constant evaluator that reports unreadable enums per enum, a pure comparison function per enum, and the layer
that resolves the enum list (named + discovered), locates declarations at both refs, compares and applies the
accept allowlist.
Rejected: regular expressions over raw text - attributes, comments and strings with commas or braces break them
(roadmap risk); Roslyn or the TypeScript compiler API - a .NET SDK or a heavy dependency for a few dozen lines of
grammar, and the package keeps one runtime dependency; materialising the whole tree and reading from disk - copies
every file of a large repo to read a few hundred sources; bounded `readFile` concurrency is enough.

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Config shape | `{ sources: glob | glob[], enums: [ {kind:"named", name, storage, file?} | {kind:"discover", files, pattern, storage} ] (min 1), accept?: [{ id, enum, member?, reason }] }`, every object strict | one list keeps named and discovered enums in one place; a discriminated union instead of a bag of optional fields (AGENTS conventions) | change, plan |
| Storage values | `string` and `int` | the change.md vocabulary; covers EF `HasConversion<string>` and default int storage | change |
| Persisted key under `string` | the member's string literal value when it has one (TypeScript string enums), else its name | EF stores the C# member name; a TS string enum stores its value | research risks |
| Persisted key under `int` | the member's evaluated numeric value (BigInt) | rows hold the number | change |
| Rename under `string` | a removed key paired with an added key when the members share a name (value changed) or, without string values, the same evaluated number → one `enum-member-renamed` `breaking` finding instead of removed + added | reads as what happened; still breaking | change |
| Rename under `int` | a value present at both refs whose names are all different → `enum-member-renamed` `needs-action` | the row meaning survives only if the meaning did not change; the tool cannot know | plan (research answers) |
| Renumber under `int` | same member name, different known value → `enum-member-renumbered` `breaking`; the old value's removal and the new value's addition are not reported again | one cause, one finding | change |
| Unknown values | a member whose value the evaluator cannot compute (a reference outside the enum, a call, a cast) under `int` storage → `enum-member-unresolved` `needs-action` when its declaration text differs between refs or it exists on one side; identical declarations stay silent | never guess a number; never flood on unchanged code | plan |
| Enum present at one ref only | revision only → `enum-added` `safe`; base only → `enum-removed` `needs-action` (rows may still hold its values); at neither → the enum fails | an added enum cannot break old builds; a removed one needs a look at the column | plan |
| Discovery | regex (validated at config load: compiles, has a capture group) applied with the `gm` flags through `matchAll` to every file matching `files` at both refs; the name is the named group `name` when present, else group 1; a namespace prefix and a trailing `?` are stripped; names are the union of both refs; a capture that is not an identifier is skipped with a note, and a discovered name declared at neither ref (the generic helper `ConfigureEnum<T>` itself) is a note, not a failure | an enum dropped from the DbContext in the revision still has rows from the base | change, research |
| Named vs discovered | a named entry overrides a discovered enum of the same name; two discover entries finding the same name with different storage → that enum fails | explicit wins; a conflict must not be resolved silently | plan |
| Locating declarations | parse every `sources` file that `git grep` reports as containing the word `enum`; match by simple name; `file` on a named entry pins the file; several declarations of one name without `file` → the enum fails, listing the paths | names are not unique across a solution | research risks |
| Languages | by extension: `.cs` → C#; `.ts`, `.tsx`, `.mts`, `.cts` → TypeScript; other files matched by `sources` are ignored with a note | the two languages in change.md | change |
| Evaluator | BigInt; integer literals (decimal, hex, binary, octal for TS, `_` separators, C# suffixes `u`/`l`), unary `-` `+` `~`, binary `* / % + - << >> & ^ |`, parentheses, references to members of the same enum (bare or `Enum.Member`); implicit value = previous + 1, first = 0; anything else → unknown | covers `[Flags]` patterns and aliases without a compiler | plan |
| Reading files | one `git grep -l -z -I -w -e enum <commit>` per side (run by the layer through `runProcess`, so `ref-tree.ts` stays untouched) selects the candidate files; only those, plus pinned `file`s, are read with `RefTree.readFile`, at most 16 in flight, one text cache per side | thousands of `.cs` files in a .NET solution; one spawn per file costs 10-20 s per side (plan review W4) | research risks, plan review |
| Unreadable enums | C# `#region`, `#pragma` and other non-conditional directives are dropped by the tokenizer; an enum with `#if`/`#elif`/`#else`/`#endif` in its body, an unreadable member segment or an unclosed body is a per-enum parse failure; the other enums of the file still parse; a target whose declaration failed to parse fails | never read a parser miss as an empty enum (plan review C1) | plan review |
| Evaluator width | shifts beyond 64 bits and results of 64 bits or more in magnitude are unknown, not a thrown RangeError; the C# underlying type is not modelled (both refs agree, so comparisons still hold) | a crash must not end the run (plan review S1) | plan review |
| Evidence | member line at the side it comes from (base for removed, revision for added, both for renamed and renumbered); plus the discovery site (path and line of the first match, revision side when present) | F7 names `PetseoDbContext.cs:188` | research F7 |
| Accept | `accept: [{ id, enum, member?, reason }]`; `member` matches the member name at either side; an entry without `member` matches only enum-level findings; accepted findings keep their class and never count; notes count the uses and name unused entries | same semantics as the openapi allowlist | CMP-1 plan |
| Failure handling | every enum is checked even when another fails; errors join into one `failed` result that keeps the findings | same as the openapi layer | CMP-1 |
| Shared files | only `src/layers/registry.ts` (one import, one entry); `src/config/config.ts` untouched | CMP-2 and CMP-5 edit the same registry in parallel | coordinator brief |

**Critical details:**
- Under `int` storage, removals and additions are computed on values, not names: `A = 1` renamed to `B = 1` is not
  a removal. Under `string` storage they are computed on keys, so reordering implicitly numbered members is silent.
- A C# value may reference a member declared later (`A = B, B = 1`); resolve references with memoised recursion
  over the whole member list and treat cycles as unknown.

## Phase 1: Enum parser and storage-aware comparison
**Discipline:** TDD. **Files:** `src/layers/persisted-enums/tokenize.ts`, `src/layers/persisted-enums/parse-enums.ts`,
`src/layers/persisted-enums/compare-enums.ts`, `test/layers/persisted-enums/parse-enums.test.ts`,
`test/layers/persisted-enums/compare-enums.test.ts`

1. `tokenize.ts`: `tokenize(text, language)` returns tokens `{ kind: "identifier" | "number" | "string" |
   "punctuation", text, line }`, skipping whitespace and comments (`//`, `/* */`), reading C# strings (`"..."`,
   verbatim `@"..."`, raw `"""..."""`, char literals) and TS strings (`'...'`, `"..."`, template literals) as one
   token each, and `@identifier` in C# as an identifier.
2. `parse-enums.ts`: `parseEnums(text, language): Result<EnumDeclaration[]>` with
   `EnumDeclaration = { name, line, members: EnumMember[] }` and
   `EnumMember = { name, line, valueText: string | null, value: bigint | null, stringValue: string | null }`;
   the function returns `{ declarations, failures: { name, line, error }[] }` so one unreadable enum does not hide
   the others of the file.
   Finds `enum <Name>` (skipping C# `: <type>` and TS `const`/`declare`/`export` modifiers), splits the body at
   depth-0 commas, skips C# attribute lists `[...]` before a member, accepts TS string-literal member names, and
   evaluates values per Key decisions. An unbalanced body is an error naming the enum and line.
3. `compare-enums.ts`: `compareEnums({ base, revision, storage }): EnumChange[]` with
   `EnumChange = { id, class, member: string, subject, message, baseMember?: EnumMember, revisionMember?: EnumMember }`
   implementing the string and int rules from Key decisions. Pure, no I/O.

**Tests:** C# with `[Flags]`, `: byte`, attributes with strings holding commas and braces, XML doc and block
comments, trailing comma, implicit numbering after an explicit value, hex/binary/`1 << n`/`A | B`, aliases
(`B = A`), forward reference, a cycle (unknown), an outside reference (unknown), negative values, several enums in
one file, nested enum in a class; TypeScript `export const enum`, `declare enum`, string enum, mixed enum, quoted
member names, implicit after a string member (unknown); empty enum; unbalanced braces (failure, earlier enums
kept); `#region`/`#pragma` dropped; `#if` in a body (failure, later enums kept); unreadable member segments
(failure); shifts and products beyond 64 bits (unknown). Comparison: string
add/remove/rename-by-number/rename-by-name, reorder silent, case change is a rename; int add/remove/renumber with no
duplicate removal, rename `needs-action`, alias added to an existing value silent, unresolved changed vs unchanged;
identical enums give no change; int swap and middle insertion give renumberings only; an implicit member after a
value that became uncomputable is unresolved, not removed; a TS string member under int storage is unresolved;
string renames pair one to one in declaration order (two removed and two added, three added for two removed).

**Done when:**
- Automated: the parser tests pass for the C# and TypeScript cases listed above.
- Automated: the comparison tests pass for every string and int rule listed above.
- Automated: Gates green (typecheck, lint, test).

## Phase 2: The `persisted-enums` layer with discovery, accept and the F7 acceptance case
**Discipline:** TDD. **Files:** `src/layers/persisted-enums/config.ts`, `src/layers/persisted-enums/persisted-enums-layer.ts`,
`src/layers/registry.ts`, `test/layers/persisted-enums/config.test.ts`,
`test/layers/persisted-enums/persisted-enums-layer.test.ts`, `test/e2e/persisted-enums.test.ts`

1. `config.ts`: `persistedEnumsConfigSchema` per Key decisions. Globs are non-empty strings; `file` uses the same
   relative-path rule as the openapi layer (no absolute path, no `..`); `pattern` must compile and have at least
   one capture group; named entries have unique names; `name` and `enum` are C# / TS identifiers.
2. `persisted-enums-layer.ts`: `persistedEnumsLayer = defineLayer({ name: "persisted-enums", ... })`. Steps:
   discover names at both refs; build the enum list (named overrides discovered); read and parse the `sources`
   files at both refs (bounded concurrency, cache); per enum, locate the declaration at each side, compare, turn
   `EnumChange`s into `Finding`s (`scope` = enum name, `subject` = `Enum.Member`, evidence per Key decisions); apply
   `accept`; return `ran`, or `failed` with every enum error joined and the findings kept. Notes: number of enums
   checked, discovered-only-at-one-side enums, ignored source files by extension, accept usage.
3. `src/layers/registry.ts`: add `persistedEnumsLayer` after `openapiLayer`.

**Tests:** config: valid named and discover entries, unknown key rejected, pattern without a group rejected, invalid
regex rejected, duplicate named entries rejected, absolute `file` rejected, empty `enums` rejected. Layer (temp git
repo): discovery from a DbContext finds the enum and adds the discovery evidence; named entry overrides discovered
storage; enum declared in two files fails with both paths, and `file` resolves it; enum missing at both refs fails
while another enum still reports its finding; enum added and removed; accept entry with and without `member`, unused
entry note. E2E through `main`: the F7 repository (C# DbContext with `ConfigureEnum<NotificationType>()` on line
188 and the generic helper `ConfigureEnum<T>` defined below it, an unrelated enum with `#if`, enum file gaining
`TermsChange`) with `--fail-on rollback-risk` exits 1 with one `rollback-risk` `enum-member-added` finding whose
evidence includes `PetseoDbContext.cs:188` and a note for the undeclared `T`; it exits 0 under the default gate and
0 with an accept entry.

**Done when:**
- Automated: the config and layer tests listed above pass.
- Automated: the F7 end-to-end test with `--fail-on rollback-risk` exits 1 with exactly one `rollback-risk` finding
  with evidence at the member line and `PetseoDbContext.cs:188`, and exits 0 with the accept entry.
- Automated: `persisted-enums` is in `LAYERS` and `src/config/config.ts` is unchanged.
- Automated: Gates green (typecheck, lint, test).

## Risks and rollback
- A parser miss on an unusual declaration → the enum fails with a message naming the file and line, which reads as
  an incomplete check (exit 1), never as `safe`. Mitigation: tolerant tokenizer and the test matrix above.
- Slow runs on large solutions → bounded concurrency and the `enum` prefilter; `sources` can be narrowed in config.
- False `breaking` on a rename that is intended → the `accept` allowlist with a reason.
- Rollback: phase 1 adds unused modules (revert the commit); phase 2 adds one registry line (revert the commit;
  configs that name `persisted-enums` then fail as unknown keys, exit 2).

## Decisions (auto)
- Should a rename under int storage be breaking, as change.md's general wording says? → `needs-action` (the stored
  number keeps the row readable; whether its meaning changed is a human call).
- Should the persisted key of a TS string enum be its name or its value? → its value (that is what TS code writes).
- Should discovery read the base ref, the revision ref, or both? → both, union (rows from the base outlive the
  configuration in the revision).
- Should the layer materialise the tree or read files through git? → `git grep` picks the candidates, then `RefTree.readFile` with bounded
  concurrency (no full checkout of a large repo).
- Unknown-valued member removed under int storage: `breaking` or `needs-action`? → `needs-action`
  (`enum-member-unresolved`): the tool cannot tell what the row held; the default gate passes it, which the report
  makes visible (plan review W3).
- `#if` branches in an enum: take all branches or fail? → fail that enum (taking all branches can merge members
  that never coexist; plan review C1).
- Is `storage` required on discover entries? → yes (no silent default; EF's default is int, PETSEO's is string).

## Progress

> `- [ ]` pending, `- [x]` done. A phase ends with ` — <commit sha>` on its done items. Never rename items.

### Phase 1: Enum parser and storage-aware comparison

#### Automated
- [x] 1.1 The parser tests pass for the C# and TypeScript cases listed in phase 1 — fd033ea
- [x] 1.2 The comparison tests pass for every string and int rule listed in phase 1 — fd033ea
- [x] 1.3 Gates green (typecheck, lint, test) — fd033ea

### Phase 2: The `persisted-enums` layer with discovery, accept and the F7 acceptance case

#### Automated
- [x] 2.1 The config and layer tests listed in phase 2 pass — 5364d58
- [x] 2.2 The F7 end-to-end test with `--fail-on rollback-risk` exits 1 with exactly one `rollback-risk` finding with evidence at the member line and `PetseoDbContext.cs:188`, and exits 0 with the accept entry — 5364d58
- [x] 2.3 `persisted-enums` is in `LAYERS` and `src/config/config.ts` is unchanged — 5364d58
- [x] 2.4 Gates green (typecheck, lint, test) — 5364d58
