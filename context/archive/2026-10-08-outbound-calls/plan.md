# Plan: outbound-calls

Input: change.md, issue #111. Complexity: small (one new layer, README, init starter).

## Approach
| Decision | Choice | Why |
| --- | --- | --- |
| Shape | new `outbound` layer, not a `config` extension | targets are not configuration keys; a layer keeps its own findings, accept and README section |
| Source | `{ name, files, pattern, flags?, host? }`, named groups `host` and `path` | mirrors `error-codes` regex sources; `host` covers a typed client whose `BaseAddress` lives elsewhere |
| Identity | `host/path` without scheme, query, fragment, trailing slash; host lower-case | interpolated query strings and casing must not read as a new target |
| Absolute path | a `path` capture with a scheme ignores the default host | one pattern can read relative and absolute calls |
| Accept | `{ target, reason }`, target glob via `matchesGlob` | same glob rules as the rest of the tool |
| Failure | a source with no file or no capture at the revision fails the layer, no findings | fail closed, as `error-codes` |
| Order | after `dependencies` | independent of other layers |

## Progress
- [x] Phase 1: config, reader, classify, layer, registry, init starter (disabled)
- [x] Phase 2: unit and layer tests, README section and README test
- [x] Gates: typecheck, lint, test, build, test:pack
