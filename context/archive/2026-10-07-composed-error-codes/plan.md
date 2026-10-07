# Plan: composed-error-codes

Input: change.md, issue #68. Complexity: small (1 phase; layer-local).

## Goal
- With a `literal` source, a `repository-entities` part source (`report: false`) and a `composed` source
  `{entity}Repository.NotFound`, a revision that adds `RepositoryErrors<FeatureFlag>.NotFound` reports
  `error-code-added FeatureFlagRepository.NotFound` and `error-code-unknown-to-client` for a client without it.
- A `report: false` part source that captures nothing at a ref does not fail the layer; a composed source that builds
  no code at the revision does.

**Out of scope:** part defaults (`{ source, default }` of composed queues); composing from composed sources.

## Key decisions
| Decision | Choice | Why |
| --- | --- | --- |
| Shape | `{ kind: "composed", name, template, parts: { part: regexSourceName } }` | the issue's shape; no default needed for codes |
| Regex sources | `kind` optional, default `regex`; new `report` (default `true`) | old configs keep working; parts are not codes |
| Names | one code per combination of part values, deduplicated, at most 1000 per ref | same as composed queues |
| Evidence | the declaration of the last part, in template order | points at the usage that supplied the entity |
| Failures | a failed part source skips the composed source with an error; no code at the revision fails it | same rule as a regex code source |
| Module | `compose-codes.ts` (pure), wiring in `error-codes-layer.ts` | testable without git fixtures |

## Progress

> `- [ ]` pending, `- [x]` done.

### Phase 1: composed code source

#### Automated
- [x] 1.1 `composed-codes.test.ts`: issue #68 acceptance, part capturing nothing at the base, composed source
  building nothing, failed part source (failed before the change)
- [x] 1.2 `config.test.ts`: `kind`/`report` defaults, unknown part source, composed part source, template mismatch
- [x] 1.3 `compose-codes.test.ts`: product, evidence, empty part, combination limit
- [x] 1.4 Gates green (typecheck, lint, test); README error-codes section updated
