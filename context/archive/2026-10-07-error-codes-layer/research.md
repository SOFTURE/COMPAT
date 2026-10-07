# Research: error-codes-layer

## What exists
- `src/resolve/ref-list.ts`: `refListSchema`, `resolveRefList(list, { repoDir, env, fetch })` returning
  `ResolvedRef[]` (`ref`, `commit?`, `resolver?`). Open each with `openRefTree({ ref: commit ?? ref, label: ref })`.
- `LayerContext.fetch` carries the GitHub `fetch` so resolvers work inside layers and tests mock them.
- Regex config conventions: `config` layer compiles user patterns with `d` and `g` flags, validates named groups at
  parse time (`compilePattern`); `persisted-enums` validates a discovery pattern with a capture group check. Layers do
  not import each other's config modules, so the new layer keeps its own small compile helper.
- Accept entries: per layer, `{ ..., reason }`, set `finding.accepted`; notes report unused entries (seed,
  persisted-enums).
- `test/readme.test.ts` requires a README section per registered layer and lists finding ids by class.

## PETSEO shape (issue)
- Server: `new Error("Shop.Cart.NotFound", ...)` style constructors in C#; some codes may come from
  `nameof`-based patterns, so the pattern stays user-configured.
- Client: a map in `constants/api.ts` keyed by the code string (`"Shop.Cart.NotFound": "..."`).

## Open points decided in plan.md
Group naming, which codes count against clients (new only), scope of findings, failure rules, accept shape.
