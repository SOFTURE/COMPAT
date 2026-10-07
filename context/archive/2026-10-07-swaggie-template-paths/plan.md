# Plan: swaggie-template-paths

Input: change.md, issue #40. Complexity: small (tokenizer, reader, one layer check, README).

## Goal
Acceptance (issue #40):
1. swaggie-style paths are read: any `${...}` hole becomes `{}`, nested backticks included;
2. a URL site the reader missed fails the layer instead of turning findings safe;
3. a regression test with a swaggie axios fixture (nested template literal, `method: 'POST'` in a separate object).

**Out of scope:** reading absolute URLs (`https://host/api/x`) as paths; other client generators.

## Approach
| Decision | Choice | Why |
| --- | --- | --- |
| Tokenizer | a TypeScript template literal is still one `string` token; each hole is skipped with its own strings, comments, braces and nested templates, kept as `${}` in `text` and as source in `holes`; the token is `isInterpolated` | the bug was the first nested backtick ending the literal; one token keeps every caller's shape |
| Path holes | `normalizePath` already turns `${}` into `{}`; leading holes before `/` (`` `${baseUrl}/api/x` ``) are dropped | a base URL hole is not part of the route |
| Miss detection | a string with `/` in the value of `url`, `uri`, `path` or `endpoint` (with optional `_`), assigned or keyed, that no operation was read from → `ClientModel.unreadUrls` | names the request sites generated clients use (`const url`, `let url_`, `{ url: ... }`) without flagging NSwag `replace("{petId}", ...)` |
| Layer | any unread URL fails the layer with the count and the first string and line | fail closed, as the README promises |
| Identifiers | `readIdentifiers` also reads the identifiers inside holes | a client call inside a template must still count as a reference |
| Enums | a TypeScript enum initializer that is a template with holes has no string value | the hole text is no longer kept, so two different templates must not compare equal |

## Progress
- [x] Phase 1: tokenizer template holes, tokenizer tests
- [x] Phase 2: reader holes and unread URLs, layer fail-closed, identifiers in holes, enum initializer
- [x] Phase 3: swaggie axios regression fixture, layer test, README
- [x] Gates: typecheck, lint, test, build, test:pack
