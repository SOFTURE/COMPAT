# Implementation review: config-layer

Reviewed: all phases @ 51f1655, 2026-10-07. Mode: full (independent read-only reviewer with reproductions in a scratch directory). Verdict before triage: FAIL (one fail-open path); after fixes: PASS.
Findings: 1 critical, 3 warning, 1 suggestion.
Gates on 51f1655: typecheck, lint, tests (167 passed, 2 real-oasdiff tests skipped locally): green. CI run 37599598641 green. No non-English text in the diff. `src/config/config.ts` unchanged; `src/layers/registry.ts` gains one import and one entry.

## Plan adherence
Every planned step is built and each phase has its commit (8814d7c, e364e28; docs in 8c3cc8e and 51f1655). Small additions stay in scope (`addDeclarations` and `compileKeyPattern` exported, `getScanner` returns a `Result`). Progress was honest. W1 and W3 are flaws in the plan's own rules, not drift from it.

## Findings

### C1: A CRLF `.env` example file yielded no keys, and the source still reported `ran`
- **Severity:** CRITICAL. **Where:** `src/layers/config/scan-dotenv.ts`, `src/layers/config/config-layer.ts`.
- **Problem:** lines were split on `\n` and `(.*)$` does not match `\r`, so every `KEY=value\r` line was skipped (reproduced); a new key documented only in a CRLF `.env.example` read as safe.
- **Fix:** a trailing `\r` is dropped before matching; a dotenv source with no key at either ref now fails like a regex source. Tests: CRLF file; dotenv source with no key.
- **Decision:** Fix now (applied).

### W1: One file of a source could mask a change in another file of the same source
- **Severity:** WARNING. **Where:** `src/layers/config/classify.ts`.
- **Problem:** requiredness was aggregated over every file of a source, so `${DB_PASSWORD}` in a test compose file hid the same new secret in the production compose file, and a dev file requiring `LOG` hid a default removed in the main file (both reproduced).
- **Fix:** comparison units are now one per file the source matched at both refs, plus one per source for files present at one ref only (so a renamed file still adds nothing). A key moved between two files that exist at both refs reads as added there (a fail-closed false positive that `accept` records). Tests for both cases and for a renamed file.
- **Decision:** Fix now (applied).

### W2: Regex evidence pointed at the start of the match, not at the key
- **Severity:** WARNING. **Where:** `src/layers/config/scan-regex.ts`.
- **Problem:** a pattern starting with `^\s*` under the `m` flag consumed a blank line, so the evidence line was off by one (reproduced).
- **Fix:** patterns compile with the `d` flag; the line comes from the `key` group's index. Test with a blank line before the match.
- **Decision:** Fix now (applied).

### W3: A source that lost every key in the revision read as "all keys removed" (`safe`)
- **Severity:** WARNING. **Where:** `src/layers/config/config-layer.ts`.
- **Problem:** a settings class reformatted so the pattern stops matching gave only `config-key-removed` and hid any key added in the same release.
- **Fix:** any source with keys at the base and none in the revision fails, naming the source. Layer test added.
- **Decision:** Fix now (applied).

### S1: The `hash` stripper's quote handling misreads some YAML
- **Severity:** SUGGESTION. **Where:** `src/layers/config/comments.ts`.
- **Problem:** an apostrophe in a plain scalar keeps a trailing comment (false positive, recordable with `accept`); a multi-line double-quoted scalar whose continuation starts with `#` hides a reference (false negative, same class as block scalars).
- **Decision:** Defer (`context/backlog/later-layers.md`, with the block-scalar and pass-through gaps).

## Summary
The layer matches the plan. C1 and W3 closed fail-open paths, W1 moved the comparison from source to file level, W2 fixed evidence lines. Gates after the fixes: typecheck, lint, tests (174 passed, 2 real-oasdiff tests skipped locally).
