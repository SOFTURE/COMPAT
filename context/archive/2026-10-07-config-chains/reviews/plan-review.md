# Plan review: config-chains

Verdict: approved.

- Scope `changed` compares declarations per source between refs, so an old asymmetry stays quiet while a removal
  from one source (the chain breaks in this release) is reported.
- A failed member skips its chain instead of reporting every key as missing; the layer already fails.
- Diff in `config.ts`, `classify.ts` and `config-layer.ts` is wiring only (#20 edits them in parallel).
