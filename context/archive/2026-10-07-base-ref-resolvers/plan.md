# Plan: base-ref-resolvers

Input: change.md, issue #21, `src/commands/check.ts`, `src/git/ref-tree.ts`, `src/report/*`. Complexity: medium.

## Goal
`softure-compat check --base github-deployment:prod --revision HEAD` compares the commit of the latest successful
production deployment with HEAD, and the report header reads `Base github-deployment:prod → 2.2.4 (26b8973…)`.

**Out of scope:** pagination beyond the newest 100 deployments; GitHub Enterprise host detection beyond
`GITHUB_API_URL`; other forges.

## Approach
**Starting point:** the ref strings go straight to `openRefTree`, which runs `git rev-parse`.

**Chosen:** a new `src/resolve/` module. `parseRefSpec` turns the flag into a discriminated union (`literal`,
`github-deployment`, `github-workflow`, `latest-tag`); `resolveRefSpec` returns `{ ref, commit?, resolver? }`.
`check.ts` resolves both flags before opening the trees, opens a tree by the resolved commit when the resolver gave
one (the deployment or run SHA is exact; a tag may have moved), and labels it with the resolved ref name.
`RefInfo` gains an optional `resolver`, rendered in the Markdown header and the JSON report (additive field, schema
version stays 1).
Rejected: shelling out to `gh api` for every call - `gh` is not always installed in CI, while a token is.

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Token | `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`; none is exit 2 | the issue; unauthenticated calls hit the 60/h limit and 404 on private repos | issue |
| Repository | `GITHUB_REPOSITORY`, else the `origin` remote URL | set in Actions; works locally | plan |
| API base | `GITHUB_API_URL`, else `https://api.github.com` | set by Actions on GHES | plan |
| Deployment pick | newest deployment (API order) whose newest status is `success`; `inactive`, `failure`, `error`, pending states are skipped | `auto_inactive` marks superseded deployments `inactive` | issue |
| Deployment ref/commit | label `deployment.ref`, commit `deployment.sha` | `ref` is the human name, `sha` is exact | plan |
| Workflow run pick | `GET .../actions/workflows/<file>/runs?status=success&per_page=1`, any event | deploy workflows run on `workflow_dispatch` or tag pushes | issue |
| Workflow ref/commit | label `head_branch` (falls back to the SHA), commit `head_sha` | a dispatched run on a tag carries the tag name | GitHub API |
| `latest-tag[:glob]` | `git tag --list <glob> --sort=-v:refname`, first entry | version order, no network | issue |
| Missing commit | exit 2: "… is not in the local clone; fetch it (actions/checkout with fetch-depth: 0)" | the issue | issue |
| Literal refs | anything else, unchanged | a git ref cannot contain `:`; only a branch literally named `latest-tag` is shadowed | plan |

## Phase 1: Resolvers
1. `src/resolve/ref-spec.ts`: `parseRefSpec`, `formatRefSpec`.
2. `src/resolve/github.ts`: token, repository, API calls (`fetch` injectable), zod schemas.
3. `src/resolve/resolve-ref.ts`: `resolveRefSpec` for every kind.

**Tests:** mocked `fetch`: deployment skips `failure`/`inactive` and picks the latest `success`; no successful
deployment is an error; workflow resolves the head SHA of the latest successful `workflow_dispatch` run; HTTP 404
and missing token errors; `latest-tag` with and without a glob on a real temp repo.

## Phase 2: Check, report, docs
1. `check.ts`: resolve both flags, open by commit, missing-commit message; `CheckIo.fetch` for tests.
2. `report.ts`, `markdown.ts`, `json.ts`: `resolver` in the header and the JSON.
3. `main.ts` usage and README "Command line" and "In CI".

**Tests:** `runCheck` with `latest-tag` and with a mocked deployment (header shows resolver), a deployment SHA not in
the clone is exit 2 with the fetch hint; report rendering with a resolver.

## Risks and rollback
- A consumer with a branch named `latest-tag` now gets the resolver; documented. Rollback: revert the commit.

## Progress
### Phase 1: Resolvers
- [x] ref-spec, github client, resolveRefSpec
- [x] unit tests
### Phase 2: Check, report, docs
- [x] check.ts wiring and report header
- [x] usage and README
