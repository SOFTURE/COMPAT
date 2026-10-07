# Plan: error-code-scoping

Input: change.md, issue #72, `src/layers/error-codes/*`, `src/layers/client-usage/*`, `src/layers/layer.ts`,
`src/layers/revisions.ts`, `src/commands/check.ts`, `src/git/glob.ts`. Complexity: small.

## Goal
```json
"error-codes": {
  "clients": [{ "name": "web", "usage": ["web-b2b"], "...": "..." }],
  "returnedBy": [
    { "codes": "Shop.*", "api": "b2c", "operations": "* /api/shop/**" },
    { "codes": "ServiceVendor.Location.*", "api": "b2b", "operations": ["POST /api/service-vendors", "PUT /api/service-vendors"] }
  ],
  "accept": [{ "code": "NotificationBroadcast.*", "reason": "admin only" }]
}
```
Only codes returned by operations a live client ref calls (and that are not `endpoint-added`) stay `needs-action`.

## Approach
| Decision | Choice | Why |
| --- | --- | --- |
| Accept globs | `matchesGlob` from `src/git/glob.ts`, as `dependencies` uses | one glob dialect in the tool |
| Unused accept | existing "matched nothing" note; `safe` findings are not accepted | a glob `returnedBy` made redundant reads as unused |
| Sharing client calls | `client-usage` returns `calls` next to `revisions`; `check` passes them to later layers as `context.calls`; never in the report | same side channel as revisions, no report schema change |
| Operation match | `METHOD /path/glob`, `*` method, case-insensitive path glob over the client's normalized path | client paths are lower-cased |
| New operations | `openapi` `endpoint-added` findings, matched with `parseOperation` and `isSamePath` | reuses client-usage path rules |
| Client mapping | `clients[].usage`, default the `client-usage` client with the same name | one app can have a client per API |
| Result | finding stays, `class: "safe"` with `reclassified { by: "error-codes", reason }`; a reached code names the operations in its message | visible in both report formats |

## Phase 1: Scoping and globs
1. Accept globs and the `safe` skip in `classify.ts`.
2. `ClientRefCalls`, `LayerOutput.calls`, `LayerContext.calls`, `splitOutput`, `check.ts`.
3. `client-usage` returns the called operations of each ref.
4. `returnedBy` and `clients[].usage` config; `scope.ts`; wire into the layer before accept.

**Tests:** accept globs counted and stale; safe findings not accepted; scoping per client (not called, only new
endpoints, reached, unknown method, no calls); config error; layer run with `calls`; check passes calls on and keeps
them out of the report; client-usage shares calls.

## Phase 2: Docs
README `error-codes` and known gaps; backlog line done.

## Risks and rollback
- A wrong `returnedBy` glob can make a code `safe`; it is declared by the owner, as accept is. Rollback: revert the commit.

## Progress
### Phase 1: Scoping and globs
- [x] accept globs
- [x] calls side channel
- [x] returnedBy scoping
- [x] tests
### Phase 2: Docs
- [x] README and backlog
