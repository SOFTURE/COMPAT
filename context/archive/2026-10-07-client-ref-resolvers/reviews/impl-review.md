# Implementation review: client-ref-resolvers

Reviewed the diff against plan.md and issue #41.

## Checked
- Acceptance: `test/resolve/ref-list.test.ts` resolves the PETSEO shape (`eas-prod.yml` runs on 2.0.1 … 2.2.4 plus a
  1.9.0 run, a re-run of 2.1.1 and a `main` run) with `since: "2.0.1"` to exactly `2.0.1, 2.0.2, 2.1.1, 2.1.2, 2.2.4`,
  each with the newest run's commit. A date `since` goes to the API as `created=>=…` and is not read as a version.
- Layer: `client-usage-layer.test.ts` reads refs from `latest-tag:app-*` and from mocked workflow runs by commit,
  labelled by tag; the evidence carries the run commit; a run commit missing from the clone fails with the fetch hint.
- Fail direction: no run, no run since the version, a `since` that is neither, HTTP errors and the 1000-run cap all
  fail the layer; nothing falls back to a guess.
- Compatibility: old `["ref"]` and `{ tags, since }` configs parse and resolve as before (existing tests unchanged).
- Reuse for #48: `refListSchema`, `resolveRefList` and `LayerContext.fetch` have no dependency on client-usage.

## Findings
- Accepted: a literal ref and a resolver that land on the same commit are read twice (different dedupe keys); only
  costs one extra read.
- Pre-existing, out of scope: `tags.since` given as a date is read as a version (`2026`), unchanged from #14.

Verdict: ready.
