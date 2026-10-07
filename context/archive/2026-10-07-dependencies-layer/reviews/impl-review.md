# Implementation review: dependencies-layer

Verdict: ready. Gates: `npm run typecheck`, `npm run lint`, `npm test` (542 passed, 14 oasdiff tests skipped
locally, forced in CI), `npm run build && npm run test:pack`.

- Acceptance: `test/e2e/dependencies.test.ts` reproduces F9 (`0.4.0 → 1.2.0` needs-action, `3.1.0 → 3.2.0` safe,
  `xunit` dropped by `ignore`).
- The MSBuild reader is regex-based: an attribute value containing `>` (a `Condition` with a comparison) on a
  package item would cut the element short. Rare in package items; noted, no change.
- Several versions of one package compare by lowest and highest version; a middle version that moves without the
  bounds moving gives no finding. Accepted for v1.
- Lockfiles and `Condition` evaluation are in the backlog.
