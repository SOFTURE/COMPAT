# Implementation review: persisted-enums-layer

Scope: full · Date: 2026-10-07 · Commits: 6dffebc..9c51360 (p1 fd033ea, p2 5364d58, progress 9c51360) ·
Gates: typecheck ✓ lint ✓ test ✓ (164 passed, 2 skipped). Mode: independent read-only reviewer with probe scripts.

## Verdict
**Not ready** at review time: the plan was delivered file for file and Progress was honest, but four confirmed
defects let a breaking enum change read as `safe`, `needs-action` or "not checked" with status `ran`.
Counts: 3 CRITICAL, 3 WARNING, 0 SUGGESTION. All six fixed in 2c52e6c (175 passed, 2 skipped).

## Dimensions
| Dimension | Verdict | Findings |
|---|---|---|
| Plan coverage / drift | OK | none; `src/config/config.ts` untouched, registry one line |
| Progress honesty | OK | every `[x]` backed by a test or gate |
| Correctness: tokenizer/parser | Fail → fixed | F1, F3 |
| Correctness: layer (locate/discovery) | Fail → fixed | F2, F4, F5 |
| Tests | Gaps → fixed | F6 |
| Security / migrations | n/a | git args are an array, the commit is a resolved SHA, `--` in place |
| Patterns / conventions | OK | English only, result values, options objects |

## Findings

### F1 [CRITICAL] The tokenizer swallows the code after common literals, so the enum vanishes without an error
- **Where:** `src/layers/persisted-enums/tokenize.ts`.
- **What:** C# `$"""…"""`, a multi-line verbatim string holding `/*`, and a TS regex literal holding `/*` opened a
  raw string or block comment that ran to the end of the file; `parseEnums` returned neither declaration nor failure.
- **Fix:** C# strings read their `$`/`@` prefix and quote count (raw, verbatim spanning lines, interpolated); TS
  `/…/flags` is skipped where a regex may start. Safety net in the layer: a declaration-looking line
  (`[modifiers] enum Name`) the parser did not recognise fails that enum.
- **Decision:** Fixed (2c52e6c), tests in `parse-enums.test.ts` and the layer test ("scanner lost").

### F2 [CRITICAL] A same-name declaration in another file hid a parse failure of the real one
- **Where:** `persisted-enums-layer.ts` `locate`.
- **Fix:** unreadable declarations in scope always fail the enum, with the readable twins named and a hint to set
  `file`.
- **Decision:** Fixed (2c52e6c), layer test "conditional members … another file declares the name".

### F3 [CRITICAL] C# char-literal initializers were read as string values
- **Where:** tokenizer, evaluator.
- **Fix:** C# `'…'` is a `char` token evaluated to its UTF-16 code unit; a C# string initializer is unknown; only
  TypeScript sets `stringValue`.
- **Decision:** Fixed (2c52e6c), tests for `Male = 'M'` → `Man = 'M'` under both storages.

### F4 [WARNING] A wrong `sources` glob read as a clean run
- **Fix:** when discovery found names and none of them is declared at either ref, the layer fails with
  `check "sources"`; a single false match (the generic `T`) next to real enums stays a note.
- **Decision:** Fixed (2c52e6c), layer test.

### F5 [WARNING] A named entry whose pinned `file` moved read as `enum-added` `safe`
- **Fix:** when the pinned file holds no declaration at one ref, the lookup falls back to the name at that ref
  (ambiguity still fails).
- **Decision:** Fixed (2c52e6c), layer tests "moved" and "pinned with file".

### F6 [WARNING] No layer test covered "target fails when its declaration cannot be parsed"
- **Decision:** Fixed (2c52e6c): four layer tests now fail if the unreadable check in `locate` is removed.

## Checked and fine
`git grep` invocation (root cwd, `sha:` prefix stripped, exit 1 = no match), the `T` note, storage conflicts,
accept matching, int renumber/swap/insert/alias/unknown chains, 64-bit guards, `#region`/`#pragma`.

## Lessons proposed
- A hand-written scanner must be tested against the literal forms of the target language version (C# 11 raw and
  interpolated raw strings, TS regex literals), and anything that looks like a declaration but was not parsed must
  fail the check, never become a note. (Relevant to CMP-2's SQL splitter; left for softure-lesson to record so the
  shared `lessons.md` is not edited by three parallel threads.)
