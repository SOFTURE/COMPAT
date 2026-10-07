# Implementation review: check-defaults

Verdict: approved. Gates: typecheck, lint, test (969 passed, 22 skipped), build and test:pack green.

- Plan followed; every Progress item is covered by a test named after the behaviour.
- Precedence is flag, config, then `breaking` for `failOn`; a missing base or revision is exit 2 after the config
  is read, and the message names the flag, the config key and the file.
- `init` never fails on GitHub: a missing repository, token or an HTTP error falls back to `latest-tag`/`HEAD` with
  the reason on stderr. The init tests drop `GITHUB_REPOSITORY`, `GH_TOKEN` and `GITHUB_TOKEN` so CI's own
  variables cannot reach the lookup; the deployment cases run against the fake GitHub.
- The deployment lookup makes one list call and at most one status call per deployment until two environments
  are found, only for deployments of environments not found yet.
- The action passes `--base`, `--revision` and `--fail-on` only when the input is set, so `--fail-on ""` never
  reaches the CLI; its self-test takes `revision` from the fixture config to exercise the new path.
- JSON stays schema version 1; `source` is additive.
- No Polish text in the diff.
