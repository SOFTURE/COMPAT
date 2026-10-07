# Plan review: backward-compat-checker

Reviewed: plan.md @ 2026-10-07. Mode: deep (independent read-only reviewer; oasdiff v1.33.0 and git behaviour verified in a scratch directory). Verdict: ready after fixes.
Findings: 1 critical, 7 warning, 2 suggestion.
Grounding: 10/12 claims (oasdiff `*Source.file` points at the `$ref`-ed file, not the spec; `--version` of a `go install` build prints `main`), 2/2 paths, 3/3 commands.

## Lenses
| Lens | Result |
| --- | --- |
| Coverage and end state | WARN (W2, W3) |
| Slicing | PASS |
| Verifiability | WARN (S9) |
| Data and migrations | PASS (not applicable) |
| Tests | WARN (W3, W6, W7) |
| Security | WARN (W6, W8) |
| Lean | PASS |
| Fit | WARN (W4, W5, S10) |
| Cost and defaults | PASS |
| Scope | PASS (the minimal CI is justified next to CMP-6) |
| Reuse | PASS |
| Lessons | PASS (none recorded) |
| Progress format | FAIL (C1) |

## Findings

### C1: Done-when bullets and Progress items are not one to one
- **Severity:** CRITICAL. **Effort:** low. **Lens:** Progress format. **Where:** phases 1 and 2.
- **Problem:** phase 1 had 3 bullets but 5 items, phase 2 had 3 bullets but 4 items (progress-format rule 11).
- **Fix:** split the Done-when bullets to match 1.1-1.5 and 2.1-2.4.
- **Decision:** Fix now (applied).

### W2: `git archive` drops `export-ignore` paths and needs a binary pipe
- **Severity:** WARNING. **Effort:** medium. **Lens:** Coverage. **Where:** Key decisions "Refs", phase 1 step 6.
- **Problem:** a spec marked `export-ignore` at one ref vanishes from the archive (verified), which yields a false `api-added safe`; `runProcess` returns strings and cannot pipe a tar stream.
- **Fix:** materialise with a temporary index (`git read-tree` + `git checkout-index --prefix`); test `export-ignore`.
- **Decision:** Fix now (applied).

### W3: oasdiff evidence points at the `$ref`-ed file
- **Severity:** WARNING. **Effort:** low. **Lens:** Coverage, Tests. **Where:** Critical details, phase 2 step 4.
- **Problem:** `*Source.file` is the file holding the change, which can be a referenced file, not the spec.
- **Fix:** make evidence paths relative to the materialised tree root; URL only for `url` sources; add a test.
- **Decision:** Fix now (applied).

### W4: RefTree cannot list files, cannot tell absent from error, and layers have no temp dir
- **Severity:** WARNING. **Effort:** medium. **Lens:** Fit (contract for CMP-2, CMP-4, CMP-5). **Where:** phase 1 steps 6-7.
- **Problem:** later layers need folder listings at both refs and would each edit `ref-tree.ts`; `git cat-file -e` exits 128 for both cases; `resolveSpec` needs a work dir the context does not give.
- **Fix:** `listFiles(pathspec)` via `git ls-tree -r -z --name-only` with `:(glob)` magic, presence through `listFiles`, `tempDir` in `LayerContext`.
- **Decision:** Fix now (applied).

### W5: `ZodType` has no `.extend` and nested unknown keys are stripped
- **Severity:** WARNING. **Effort:** low. **Lens:** Fit. **Where:** phase 1 steps 7-8.
- **Fix:** type `configSchema` as a zod object; every layer uses `z.strictObject`; nested-typo test.
- **Decision:** Fix now (applied).

### W6: an id-only accept entry hides the same check on every endpoint
- **Severity:** WARNING. **Effort:** low. **Lens:** Security (gate). **Where:** Key decisions "Accept allowlist".
- **Fix:** an entry without `operation` matches only operation-less changes; notes count accepted findings per entry; test for another operation.
- **Decision:** Fix now (applied).

### W7: a crash exits 1 and `cli.ts` is not testable in-process
- **Severity:** WARNING. **Effort:** low. **Lens:** Tests. **Where:** phase 1 steps 10-11.
- **Fix:** `main(argv, io)` in `src/main.ts`, a thin `cli.ts`, any throw → 2 without a stack; unwritable `--output` → 2.
- **Decision:** Fix now (applied).

### W8: URL secrets, path escapes and option injection
- **Severity:** WARNING. **Effort:** low. **Lens:** Security. **Where:** spec sources, refs.
- **Fix:** redact user info and query in messages; reject absolute and `..` paths and realpaths outside the tree; `--end-of-options` for refs; tests for each.
- **Decision:** Fix now (applied).

### S9: the pack test can pass vacuously and runs `prepack`
- **Severity:** SUGGESTION. **Effort:** low. **Lens:** Verifiability. **Where:** phase 3 step 3.
- **Fix:** `--ignore-scripts`, fail when `dist/` is missing; the version note is informative only.
- **Decision:** Fix now (applied).

### S10: user `oasdiff.args` can override `--format json`
- **Severity:** SUGGESTION. **Effort:** low. **Lens:** Fit. **Where:** Key decisions.
- **Fix:** user args before the fixed flags; reject `--format`, `-f`, `--fail-on`, `-o`.
- **Decision:** Fix now (applied).

## Summary
Every finding was fixed in plan.md (autonomous mode, owner-autonomy rule). Verdict after triage: ready. Next: `softure-implement backward-compat-checker`.
