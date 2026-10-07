# Plan: error-codes-layer

Input: change.md, research.md, issue #48, `src/resolve/ref-list.ts`, `src/layers/client-usage/*`,
`src/layers/config/config.ts` (pattern compile), `src/commands/init.ts`, `test/readme.test.ts`. Complexity: medium.

## Goal
```json
"error-codes": {
  "codes": [{ "name": "api", "files": ["src/**/*.cs"], "pattern": "new Error\\(\\s*\"(?<code>[\\w.]+)\"" }],
  "clients": [{
    "name": "mobile",
    "refs": { "workflowRuns": "eas-prod.yml", "since": "2.0.1" },
    "files": ["APP/MOBILE/B2C/constants/api.ts"],
    "pattern": "\"(?<code>[\\w.]+)\"\\s*:"
  }]
}
```
On the PETSEO shape, every code new in the revision that `mobile@2.0.1 … 2.2.4` does not translate becomes
`error-code-unknown-to-client` (`needs-action`) naming the refs that lack it; added and removed codes are `safe`.

**Out of scope:** tying codes to the operations that return them (the issue's "optional precision later"; stays a
backlog line); init detection of code patterns (init writes a disabled example).

## Approach
**Chosen:** a standalone layer in `src/layers/error-codes/`:
- `config.ts`: schema (`codes[]`, `clients[]`, `accept[]`), finding ids, `compileCodePattern` (own helper; the
  layer does not import another layer's config module).
- `read-codes.ts`: `readCodes(text, regex)` → `{ code, line }[]` from the named group `code`.
- `classify.ts`: pure `classifyErrorCodes({ base, revision, clients })` → findings, plus `applyAccept`.
- `error-codes-layer.ts`: reads sources at both refs, resolves client refs with `resolveRefList`, opens each by
  commit, reads the map files, then classifies.
- `formatResolvers` moves from the client-usage layer to `src/resolve/ref-list.ts` so both layers share it.

**Key decisions:**
| Decision | Choice | Why |
| --- | --- | --- |
| Code capture | named group `code` required, checked when the config is parsed | explicit, same as `config` regex sources |
| Flags | `flags` of `i`, `m`, `s`, `u`; `g` and `d` added by the layer | same as `config` regex sources |
| Codes counted against clients | only codes new in the revision | a code the base already returns is already live; the issue asks for new ones |
| Code in several sources | one code; scope and evidence from the first source and first line | a code is one string to the client |
| Finding per | `(client, code)`; subject is the code, scope the client name | one action per client map |
| Message | `not translated by mobile@2.0.1, 2.1.1; these builds show a generic error` | names the refs that lack it |
| Evidence | revision declaration, plus each lacking ref's map file (`side: "client"`) | where to add the key |
| Clients that know the code | no finding for that client | shipped ahead of the server |
| Fail closed | a code source with no file or no code at the revision, a client map with no file or no key at a ref, a missing client commit, a resolver error: the layer fails | a wrong pattern must not read as "nothing to report" |
| Partial failure | other sources and clients still run; findings made so far count | same as `seed` |
| Accept | `{ code, client?, reason }`, applies to `error-code-unknown-to-client`; unused entries noted | same shape as other layers |
| Registry place | after `client-usage` | groups client-facing layers in reports |

## Phase 1: Layer
1. `config.ts`, `read-codes.ts`, `classify.ts`, `error-codes-layer.ts`; register it.
2. Move `formatResolvers` to `ref-list.ts`.

**Tests:** pattern validation (no `code` group, bad flags, invalid regex); `readCodes` lines and duplicates;
classify added/removed/unknown with a client that knows some codes, multiple refs, accept used and unused; layer
over a git fixture with tagged client builds (`tags` selector), map missing at an old ref, zero keys, no source
file, resolver note.

## Phase 2: Init, docs
1. `init` writes a disabled `error-codes` example with a summary saying why.
2. README `### error-codes` section with config table and finding ids; backlog line for operation precision.

**Tests:** README test lists every finding id under its class; init test still covers every layer.

## Risks and rollback
- New layer, off unless configured. Rollback: revert the merge commit.

## Progress
### Phase 1: Layer
- [x] config, reader, classify, layer, registry
- [x] shared formatResolvers
- [x] unit and layer tests
### Phase 2: Init, docs
- [x] init starter entry
- [x] README and backlog
