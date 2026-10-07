# Implementation review: backward-compat-checker

Reviewed: all phases @ 785fa1c, 2026-10-07. Mode: full (independent read-only reviewer with reproductions in a scratch directory). Verdict before triage: FAIL; after fixes: PASS.
Findings: 2 critical, 6 warning, 2 suggestion.
Gates on 785fa1c: typecheck, lint, tests (97/97 with real oasdiff), build, pack test: green. CI run 37596461332 green. No non-English text in the diff.

## Plan adherence
Every planned step is built and every phase has its commit (9b76792, ac2b0f4, f33ea8c). Additions beyond the plan (`Layer.description`, `defineLayer`, `src/report/report.ts`, `src/main.ts` as the testable entry) are small and in scope. Progress was honest: 3.2 stayed open until CI was green.

## Findings

### C1: `--allow-incomplete` dropped breaking findings already found
- **Severity:** CRITICAL. **Where:** `src/layers/openapi/openapi-layer.ts`, `src/model/finding.ts`.
- **Problem:** one failing API turned the layer into `failed` without findings, so a breaking change in another API passed the gate with `--allow-incomplete` (reproduced: exit 0).
- **Fix:** a `failed` result carries `findings` and `notes`; the gate counts them; the layer checks every API and joins the errors. Tests: two APIs, one failing; gate on a failed layer with a breaking finding.
- **Decision:** Fix now (applied).

### C2: `--repo` in a subdirectory mixed three path bases in `RefTree`
- **Severity:** CRITICAL. **Where:** `src/git/ref-tree.ts`.
- **Problem:** `ls-tree` listed subdirectory-relative paths while `cat-file` expected root-relative ones; a present file read as absent (fail open for later layers).
- **Fix:** resolve `git rev-parse --show-toplevel` once (`resolveRepoRoot`), run every git command there, `ls-tree --full-tree`; all `RefTree` paths are repository-root relative. Tests: subdirectory `repoDir`, directory outside any repository.
- **Decision:** Fix now (applied).

### W1: evidence named the wrong file behind a symlinked temp dir (macOS)
- **Fix:** `materialize()` returns the real path of the tree. Test with a symlinked temp root.
- **Decision:** Fix now (applied).

### W2: Ctrl-C or a CI cancel left child processes and the temp tree behind
- **Fix:** `runProcess` keeps a registry of live process groups; the CLI installs SIGINT/SIGTERM handlers for the run (`handleSignals`) that kill the groups, remove the temp root and exit 130/143.
- **Verification:** manual on the built CLI: after `kill -INT`, no `sleep` from the command source and no temp dir remained. No automated test, because the handler calls `process.exit` and the TypeScript CLI cannot be spawned from the tests before a build.
- **Decision:** Fix now (applied).

### W3: a command that exits but leaves a background process hung until the timeout
- **Fix:** `runProcess` settles on `exit` plus a 1 s drain grace, then kills what is left in the group; git calls get a 10 min timeout. Tests: `sleep 30 & echo built` returns at once; `sleep 30 & wait` times out at once.
- **Decision:** Fix now (applied).

### W4: tests did not guard process groups, `--end-of-options` or oasdiff lookup errors
- **Fix:** grandchild tests above; tests for a configured missing path, a non-executable path (EACCES), and a failing `--version`.
- **Not fixed:** a test that fails without `--end-of-options`. `rev-parse` receives `<ref>^{commit}`, and no option spelling with that suffix is parsed as an option (checked with `--since=…^{commit}` and `--git-dir^{commit}`), so the flag stays as defence in depth without a test that could fail.
- **Decision:** Fix now (applied, except the untestable part, dismissed with the reason above).

### W5: a `command` source could compare a stale committed output file
- **Fix:** the output path is deleted from the materialised tree before the command runs. Test: a command that writes nothing while the output path is committed fails.
- **Decision:** Fix now (applied).

### W6: a configured oasdiff that cannot run read as `skipped`
- **Fix:** only an implicit `oasdiff` missing from `PATH` is `skipped`; a configured path (config or `SOFTURE_COMPAT_OASDIFF`) that cannot run is `failed`, and a relative one resolves against the repository root.
- **Decision:** Fix now (applied).

### S1: `readFile` decoding for later layers
- **Fix:** BOM stripped, file presence through a `Set`. UTF-16 SQL Server scripts are deferred to CMP-2, which owns SQL reading (`context/backlog/core.md`).
- **Decision:** Fix now (applied in part), rest deferred.

### S2: Markdown escaping missed HTML and mentions
- **Fix:** `<` and `>` become entities, `@` that starts a mention gets a zero-width space, the finding id cannot break out of its code span. Test added.
- **Decision:** Fix now (applied).

## Summary
All CRITICAL and WARNING findings are fixed; 110 tests pass with real oasdiff (`COMPAT_REQUIRE_OASDIFF=1`), plus the pack test. Next: `softure-archive backward-compat-checker`.
