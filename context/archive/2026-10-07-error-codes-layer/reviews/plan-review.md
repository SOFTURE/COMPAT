# Plan review: error-codes-layer

- Covers the issue: `codes` regex sources at both refs, per-client translation map and key regex read at live refs
  (reusing `refListSchema`/`resolveRefList`), `error-code-added`/`-removed` as `safe`,
  `error-code-unknown-to-client` as `needs-action`. Operation-level precision is explicitly deferred, as the issue
  marks it "later".
- Fail direction: every way the reader could see nothing (no file, no match, missing commit) fails the layer, so a
  bad pattern cannot hide an unknown code.
- No cross-layer import: `formatResolvers` moves into `src/resolve/`, the pattern helper is local.
- Watch: `init` requires a starter entry for every registered layer, and `readme.test.ts` a section per layer; both
  are in Phase 2.
- Watch: a JS regex with `g` keeps `lastIndex`; use `matchAll` on a fresh regex per read.

Verdict: ready to implement.
