# Implementation review: behaviour-layer

Verdict: approved.

- Both acceptance cases of issue #22 are covered end to end (`test/e2e/behaviour.test.ts`): a revision that renames
  a response field makes the base test fail as `base-test-failed`, `breaking`; after a `test` timeout `stop` runs and
  the background app's process is gone.
- `stop` and the background stop sit in the `finally` of `runStackCycle`; a failed `start`, a `ready` timeout, a
  test timeout and unreadable results all reach it (the not-ready case is tested too).
- A crash of the test command never reads as a pass: no result file, or result files without a test case, fail the
  layer with the exit code and the output tail.
- Stale results cannot leak between the baseline, the main cycle and retries: matching files are deleted before each
  attempt.
- The XML reader rejects DTD internal subsets, so no entity expansion; unknown entities stay as text.
- Gates: typecheck, lint, full suite and the pack test pass. No Polish in the diff.
