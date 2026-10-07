# Plan review: github-action

## Checked
- Constraints of change.md: composite action, published CLI, version pinned to the release, comment skipped without
  permission: each maps to a decision row.
- Fail direction: the gate step runs after the summary and the comment, so a red gate never hides the report; a
  failed comment never turns a green gate red.
- Injection: every input reaches the scripts through `env`, never through `${{ }}` inside `run`.

## Findings
- Fixed in the plan: the major tag must not move to a release without `action.yml` (0.2.0 and older), or `@v0` would
  break between this merge and 0.3.0.

Verdict: ready.
