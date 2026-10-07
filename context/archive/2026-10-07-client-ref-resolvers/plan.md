# Plan: client-ref-resolvers

Input: change.md, issue #41, `src/resolve/*`, `src/layers/client-usage/{config,client-refs,client-usage-layer}.ts`,
`src/commands/check.ts`. Complexity: medium.

## Goal
```json
"refs": ["github-deployment:prod"]
"refs": { "workflowRuns": "eas-prod.yml", "since": "2.0.1" }
```
both work in `client-usage`; the second resolves on PETSEO to `2.0.1, 2.0.2, 2.1.1, 2.1.2, 2.2.4`, and the layer
notes read `client "mobile": workflowRuns:eas-prod.yml since 2.0.1 → 2.0.1, 2.0.2, …`.

**Out of scope:** store or Sentry release data (backlog line stays); GitHub Enterprise beyond `GITHUB_API_URL`.

## Approach
**Starting point:** `clientRefsSchema` (list of literal refs or `{ tags, since }`) and `resolveClientRefs` live in
the client-usage layer and return plain ref names; trees are opened by name.

**Chosen:** a reusable ref list in `src/resolve/ref-list.ts`:
- `refListSchema`: a non-empty array of entries, or one selector object (back compatible). An entry is a ref
  string (parsed with `parseRefSpec`, so literal or any single-ref resolver), `{ tags, since? }` or
  `{ workflowRuns, since? }`.
- `resolveRefList(list, options) → Result<ResolvedRef[]>`: resolves every entry, keeps `ResolvedRef.commit` and a
  `resolver` label per non-literal entry, dedupes by commit (or ref) keeping the first.
- `parseVersion`, `compareVersions`, `selectTags` move to `src/resolve/versions.ts`.
- `resolveWorkflowRuns` in `resolve-ref.ts` next to the single-run resolver.
client-usage opens each ref by commit (labelled by ref), like `check.ts` does for `--base`, and adds one note per
resolver. `LayerContext` gains optional `fetch` (passed from `CheckIo.fetch`) so layers can call GitHub resolvers
and tests can mock them. #48 imports `refListSchema` and `resolveRefList` directly.
Rejected: keeping the schema in the client-usage layer and having #48 import from it (cross-layer dependency).

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Runs listed | `GET /actions/workflows/<file>/runs?status=success&per_page=100&page=N`, all events | build workflows run on tag pushes or dispatch | issue, #21 |
| Run label / commit | `head_branch` (tag name for tag runs), falls back to the SHA; commit `head_sha` | same as `github-workflow:` | #21 |
| Duplicate runs | one ref per label, newest run wins (API order is newest first) | re-runs of a tag | plan |
| `since` | `YYYY-MM-DD` → passed as `created=>=<date>`; otherwise a version: runs whose label holds a version ≥ it, others dropped | the issue; same rule as `tags.since` | issue |
| Order | version order, unversioned last (as `tags`) | readable notes, stable reports | plan |
| Page cap | 10 pages (1000 runs); more is an error asking for a date `since` | fail closed, bounded API use | plan |
| No run | error `no successful run of workflow …` | never a guess | #21 |
| Missing commit locally | layer fails with the fetch hint | as for `--base` | #21 |

## Phase 1: Resolvers
1. `src/resolve/versions.ts` (moved helpers), `resolveWorkflowRuns` in `resolve-ref.ts`.
2. `src/resolve/ref-list.ts`: schema, `formatRefSelector`, `resolveRefList`.

**Tests:** workflow runs since a version (PETSEO shape with interleaved server tags), since a date (query param),
dedupe of re-runs, pagination, page cap, empty result, HTTP error; ref list mixing a literal, `latest-tag`, a
deployment and `tags`; schema accepts old forms and rejects unknown keys.

## Phase 2: Layer, docs
1. `config.ts` uses `refListSchema`; `client-usage-layer.ts` opens by commit, notes per resolver; delete
   `client-refs.ts`.
2. `LayerContext.fetch`, wired in `check.ts`.
3. README `client-usage` refs row and example.

**Tests:** layer with `latest-tag` and a mocked `workflowRuns`, note text, unknown commit fails with the fetch hint.

## Risks and rollback
- Mixed arrays are new syntax; old syntax is unchanged. Rollback: revert the merge commit.

## Progress
### Phase 1: Resolvers
- [x] versions, workflow runs resolver
- [x] ref list
- [x] unit tests
### Phase 2: Layer, docs
- [x] layer wiring and LayerContext.fetch
- [x] README
