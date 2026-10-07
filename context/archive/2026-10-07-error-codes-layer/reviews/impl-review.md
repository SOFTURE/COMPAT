# Implementation review: error-codes-layer

Reviewed the diff against plan.md and issue #48.

## Checked
- Acceptance: `error-codes-layer.test.ts` builds the PETSEO shape (server tags 2.2.4 and 2.3.5, mobile tags 2.0.1 and
  2.2.4 with a growing `constants/api.ts` map). `Shop.Cart.NotFound` is unknown to `mobile-2.0.1` only, and
  `FeatureFlag.General.Disabled` to both refs, each as `error-code-unknown-to-client` (`needs-action`) with the
  declaration line and the lacking maps as evidence; added and removed codes are `safe`.
- Ref reuse: client refs go through `refListSchema` and `resolveRefList`, open by commit, and notes name each
  resolver through the shared `formatResolvers` (moved to `src/resolve/ref-list.ts`; client-usage unchanged).
- Fail direction: a code source with no file or no capture at the revision fails the layer and reports no code
  finding (an absent source would turn codes into removed/added); a client map missing or with no key at a ref, or a
  client commit missing from the clone, fails the layer while the code findings still count.
- Config: patterns need the named group `code`, compile at parse time, `flags` limited to `i m s u`; names unique;
  unknown keys rejected.
- `init` writes a disabled example (parsed by the config schema in the init tests); README section and the README
  test list every finding id under its class.

## Findings
- Fixed: accept notes are skipped when the comparison did not run, so entries are not reported as unused.
- Accepted: a commented-out code declaration still counts; patterns are user-owned and can exclude comments.
- Deferred (backlog line): tying codes to the operations that return them.

Verdict: ready.
