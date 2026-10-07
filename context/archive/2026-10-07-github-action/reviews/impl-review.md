# Implementation review: github-action

Reviewed the diff against plan.md and change.md.

## Checked
- Acceptance: the CI `action (self-test)` job ran `uses: ./` with the CLI packed from the same commit; the gate failed
  with exit code 1 on the `truncate` finding, the report reached the job summary, and the first run created the
  `<!-- softure-compat:self-test -->` comment on PR #49; the second run updated the same comment.
- Pinning: without `package`, the run step reads the version from `package.json` at `github.action_path`; run locally
  it installed `@softure-ai/compat@0.2.0` from npm and reported exit code 2 with a summary note for a bad ref.
- Injection: inputs reach the scripts only through `env`; the marker is passed to jq through `env.MARKER`.
- Fail direction: a failed comment call is a warning; the gate step runs last, so a red gate keeps the report.
- `release.yml`: `move-major-tag` skips prereleases and releases without `action.yml`, so the merge of this change
  does not point `v0` at 0.2.0.

## Findings
- Fixed during review: YAML descriptions containing `: ` broke the action metadata (actionlint caught it); the comment
  cut now drops the partial last line so a multi-byte character is never split.
- Accepted: `args` is split on whitespace, without shell quoting; documented in README.
- The self-test job runs with `comment: "false"` after the comment path was verified, so pull requests in this
  repository do not get a fixture report.

Verdict: ready.
