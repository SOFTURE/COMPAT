# Plan: github-action

Input: change.md, roadmap v2 CMP-11, README "In CI", `.github/workflows/release.yml`, `src/main.ts` (flags, exit
codes). Complexity: small.

## Goal
`uses: SOFTURE/COMPAT@v0` runs `softure-compat check`, writes the Markdown report to the job summary, creates or
updates one report comment on the pull request and then applies the gate; `release.yml` moves `v0` on every stable
release.

**Out of scope:** SARIF (rejected in the roadmap), a JavaScript action, check-run annotations per finding.

## Approach
**Starting point:** README "In CI" writes the report to a file inside the job; nobody reads it unless the gate fails,
and `needs-action` findings never fail the default gate.

**Chosen:** a composite `action.yml` at the root with three steps: run the CLI with `--output` into `$RUNNER_TEMP`
(exit code captured, not failed yet) and append the report to `$GITHUB_STEP_SUMMARY`; on pull requests, find the
comment starting with `<!-- softure-compat:<comment-key> -->` through `gh api` and PATCH it or POST a new one; last,
exit with the CLI's code. The CLI is run with `npx --package=@softure-ai/compat@<version>` where the version is read at
run time from `package.json` next to `action.yml` (`github.action_path`), so a tag always runs the CLI released from
that commit and no second copy of the version has to be bumped.
Rejected: a bundled JavaScript action (change.md forbids it); a version literal in `action.yml` (one more place to
bump, drifts silently); building the CLI from the action's source on every run (slow, needs dev dependencies).

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| CLI version | `package.json` at `github.action_path`; `package` input overrides | pinned to the release by construction | change.md risk |
| Comment identity | hidden marker with `comment-key` | several checks on one PR keep separate comments | plan |
| Comment failure | warning, never fails the step | forks and read-only tokens; the summary still has the report | change.md |
| Gate order | summary and comment first, gate last | a failing gate must still publish the report | plan |
| Comment size | cut at 60000 bytes on a line boundary, link to the run | GitHub limit is 65536 characters | GitHub docs |
| Node.js | `actions/setup-node` with `node-version` 22; empty skips | runners default to Node 20, the CLI needs 22 | package.json engines |
| Major tag | new `move-major-tag` job; moves `vN` to the commit of `vX.Y.Z` when it has `action.yml`; skips prereleases | idempotent, never points `v0` at a version without the action | plan |
| Self-test | CI job runs `uses: ./` with the packed CLI on a fixture repo whose seed truncates a table | tests the action and the CLI of the same commit | plan |

## Phase 1: Action, workflows, docs
1. `action.yml`: inputs base, revision, fail-on, config, working-directory, args, comment, comment-key, package,
   node-version, github-token; outputs exit-code, report.
2. `.github/workflows/ci.yml`: `action` job, `fail-on: needs-action`, `continue-on-error`, asserts outcome failure,
   exit code 1 and a `truncate` finding in the report.
3. `.github/workflows/release.yml`: `move-major-tag` job.
4. README "In CI" (usage, inputs table, outputs) and "Releasing" (step 4); `test/readme.test.ts` checks every input is
   documented.

**Tests:** actionlint on the workflows and the action; the run step executed locally against a packed tarball and
against the published 0.2.0 (gate fail and could-not-run paths); the CI self-test; the first CI run verifies the PR
comment once.

## Risks and rollback
- `v0` is created only by the first release that contains `action.yml` (0.3.0, CMP-12); until then README's `@v0`
  does not resolve. Accepted: CMP-12 is the next item.
- Rollback: revert the commit and delete the `v0` tag.

## Progress
### Phase 1: Action, workflows, docs
- [x] 1. action.yml
- [x] 2. CI self-test job
- [x] 3. release.yml moves the major tag
- [x] 4. README and readme test
