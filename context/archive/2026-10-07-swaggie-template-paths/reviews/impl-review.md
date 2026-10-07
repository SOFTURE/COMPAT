# Implementation review: swaggie-template-paths

Verdict: approved.

- Acceptance 1: `reads swaggie axios paths with nested template literals (issue #40)` reads all three operations of
  the fixture, including the body type of the POST and a path with two nested holes and a query.
- Acceptance 2: `reports URL strings no operation was read from` and the layer case for tag `app-4` fail closed.
  Existing NSwag, swaggie fetch, orval, axios and openapi-typescript fixtures report no unread URL, so known
  clients do not start failing.
- Acceptance 3: the fixture keeps `method: 'POST'` in a separate object literal passed to `axios.request`.
- Shared tokenizer: hole text is no longer kept, so a TypeScript enum initializer with holes now has no string value
  instead of a text that could compare equal across versions (test added).
- Risk accepted: a non-URL string with `/` assigned to a variable named `path`/`url` in a generated client fails the
  layer. That is the fail-closed direction the layer promises.
