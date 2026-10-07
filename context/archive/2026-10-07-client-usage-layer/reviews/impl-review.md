# Impl review: client-usage-layer

Reviewed the diff against plan.md, AGENTS.md conventions and the scanner lesson (a parser miss must never read as
"absent").

## Findings
| # | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| W1 | warning | A generated client whose paths lack the spec's base path (`/pets` against `/api/pets`) matched no operation, so every finding of the API would drop to `safe` | fixed: `isSamePath` also matches when one path ends with the other |
| W2 | warning | A top-level arrow function (`const f = (id) => fetch(\`/x/${id}\`, { method: "DELETE" })`) had no enclosing block, so its method was not read | fixed: the call the path is an argument of is searched first |
| W3 | warning | A `"/a/" + id + "/b"` concatenation produced a second operation for `/b` | fixed: literals consumed by a concatenation are skipped |
| S1 | suggestion | `sources` matches client functions by name only; a name reused elsewhere counts as a call | kept: errs towards "called" |
| S2 | suggestion | Response-side reads, query and header parameters are not refined | out of scope (plan.md) |

## Verdict
Ready: gates green (typecheck, lint, 660 tests, build, test:pack); acceptance cases of issue #14 covered by
`test/e2e/client-usage.test.ts` with real oasdiff.
