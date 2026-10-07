# Plan: client-usage-layer

Input: change.md, issue #14. Complexity: large (a core contract change, one new layer folder with a TypeScript
client reader, a README section).

## Goal
With `layers.client-usage` next to `layers.openapi` in `compat.config.json`:

```json
"client-usage": {
  "clients": [
    {
      "name": "mobile",
      "api": "b2c",
      "refs": ["2.0.1", "2.1.1", "2.2.4"],
      "generatedClient": { "kind": "typescript", "path": "APP/MOBILE/B2C/services/api/petseo.client.ts" },
      "sources": ["APP/MOBILE/B2C/{app,components,services,hooks}/**/*.{ts,tsx}"]
    }
  ]
}
```

`refs` may also be `{ "tags": "2.*", "since": "2.0.1" }`.

Acceptance (issue #14):
- a spec where a request property becomes required, plus a client ref whose generated client always sends it →
  the finding becomes `safe` with evidence; a second client ref that omits it keeps it `breaking`;
- an operation removed from the spec but still called by a live client stays `breaking` and names the client and
  ref.

**Out of scope:** generated clients in other languages (the `kind` discriminator keeps the reader pluggable);
response-side reads (a response finding on a called operation keeps its class and gets the call as evidence);
query and header parameters; reading live versions from stores or Sentry (backlog).

## Approach
A refinement contract in the core, then a layer that only refines.

**Key decisions:**
| Decision | Choice | Why |
| --- | --- | --- |
| Cross-layer contract | `LayerContext.results`: results of the layers that ran before, in registry order. `run` may return `revisions: { layer, index, finding }[]` next to its own result; `check.ts` applies them and drops the field | layers stay pure; the core owns every result; #15 can reuse it |
| Revision guard | a revision must target an earlier layer and an existing index, and keep `layer`, `scope`, `id`, `subject` and `accepted`; otherwise the refining layer becomes `failed` | a refinement can change a class, never hide a finding |
| Report | `Finding.reclassified?: { from, by, reason }`, printed under the finding in Markdown and kept in JSON; evidence side may be `client` | a reader sees why a `breaking` change shows as `safe` |
| Registry order | `client-usage` right after `openapi` | it needs the openapi results |
| No openapi layer | `failed`: `client-usage` refines `openapi` findings; enable `layers.openapi` | a refiner with nothing to refine is a config mistake |
| Client refs | list of git refs, or `{ tags: glob, since? }` resolved with `git tag --list` and a numeric version compare; zero refs or a ref missing locally → `failed` | issue #14 |
| TypeScript reader | reuses the persisted-enums tokenizer; operations from path literals (`'/api/x/' + id`, `` `/api/${id}` ``, NSwag `url_`) joined with the HTTP method found in the enclosing block (`method: 'POST'`, `.post(`, `POST(`) or the members of an openapi-typescript `paths` key; the declaring function name and its body parameter come from the nearest declaration | covers NSwag TS, swaggie, orval and axios style; openapi-typescript for operation presence |
| Paths | query dropped, parameters normalized to `{}`, literal segments compared case-insensitively; a client path that ends with the spec path, or the reverse, also matches | ASP.NET routes are case-insensitive; PETSEO mixes `{petId}` and `{PetId}`; a client base path must not turn every finding into "not called" |
| Request properties | types from `interface`, `type X = {}` and `class` members; a property is always sent when declared without `?` and without `undefined` (required rules) or without `null` (not-nullable rule); nested `a/b` walks named types | issue #14: "typed parameter being non-optional" |
| `sources` | when set, an operation counts as called only if its client function name appears as an identifier in a matching file; an unknown name counts as called | narrows to real call sites, conservatively |
| Fail closed | generated client absent at a ref, no operation read from it, or `sources` matching no file → `failed`; a path literal without a method counts as called with any method (note) | a parser miss must never read as "not called" |
| Which findings | `openapi` findings of the client's API, not accepted, class above `safe`, subject `METHOD /path` | the rest has nothing to refine |

## Progress
- [x] Phase 1: core contract (context results, revisions, `reclassified`, evidence side `client`, Markdown)
- [x] Phase 2: layer: config, ref resolution, TypeScript reader, refinement, registry line, `init` starter (disabled example)
- [x] Phase 3: unit tests, e2e acceptance with real oasdiff, README section
- [x] Gates: typecheck, lint, test (660), build, test:pack
