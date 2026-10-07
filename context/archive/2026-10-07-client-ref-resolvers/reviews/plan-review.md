# Plan review: client-ref-resolvers

- Covers the issue: single-ref resolvers in `refs` (any entry parsed by `parseRefSpec`), the `workflowRuns`
  multi-ref selector with version or date `since`, resolved refs named in the layer notes.
- Reuse for #48: schema and resolver sit in `src/resolve/`, with no dependency on the client-usage layer; a second
  layer only needs `refListSchema`, `resolveRefList` and `LayerContext.fetch`.
- Fail direction: every resolver failure, an empty run list, and the page cap fail the layer; nothing is guessed.
- Compatibility: both old forms still parse; tests keep the old `tags` behaviour.
- Watch: a date `since` must not be parsed as a version (`2026-01-01` holds digits); the date check runs first.

Verdict: ready to implement.
