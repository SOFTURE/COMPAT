# Plan review: check-defaults

Verdict: approved.

- Every goal line maps to a test in Progress; the issue's three bullets are all covered.
- Moving the missing-ref check from `main.ts` to `runCheck` changes the message of an existing exit-2 path; the
  exit code stays 2, which is the contract. `main.test.ts` must be updated, not deleted.
- `init` talking to GitHub must never fail `init`: every error path falls back to `latest-tag` with a printed reason.
  Tests must pin the env (`GITHUB_ENV` + fake fetch, or no repository) so CI's own `GITHUB_*` variables do not leak in.
- `source` is additive in JSON (schema version stays 1).
- The action's empty `fail-on` default must not pass `--fail-on ""` (that would be exit 2).
