# Implementation review: compose-scanning-gaps

Reviewed: phase 1, 2026-10-07. Mode: self review with probes on a realistic compose file. Verdict: PASS.
Gates: typecheck, lint, tests (899 passed, 22 skipped locally). No non-English text in the diff.

## Plan adherence
Every step is built: `maskYamlComments` (`yaml-text.ts`), `findPassThroughKeys` (`compose-environment.ts`),
`scanCompose` using both, a layer test and the README note. The shared `stripComments` is untouched, so dotenv,
regex and message-contracts readers keep their behaviour.

## Probe
A compose file with `x-common-env: &common-env` merged via `<<:`, a `KEY:` entry, a folded block `command: >` holding
`# ${INLINE}`, a flow `environment: [QUEUE_NAME, "DEBUG=0"]`, a quoted healthcheck URL with `#` and a label with
backticks gave exactly `REGISTRY`, `TAG` (default), `LOG_LEVEL` (default), `API_TOKEN`, `INLINE`, `DATABASE_URL`,
`STRIPE_KEY`, `QUEUE_NAME`; `REDIS_URL` (has a value) and `DEBUG` (assigned) were not reported.

## Findings

### S1: A plain multi-line scalar whose continuation line starts with a quote opens a quoted scalar
- **Severity:** SUGGESTION. **Where:** `src/layers/config/yaml-text.ts`.
- **Problem:** continuation lines of plain scalars are lexed as token starts; one starting with `'` or `"` would be
  read as a quoted scalar until the matching quote, hiding comments (extra keys, fail-closed) and structure for
  pass-through entries in that span. Such continuations are unusual in compose files; tracking plain-scalar
  continuation needs indentation of the owning node for every scalar.
- **Decision:** Keep; documented here.

### S2: Explicit block indentation indicators and tab indentation are not modelled
- **Severity:** SUGGESTION. **Where:** `src/layers/config/yaml-text.ts`.
- **Problem:** `|2` content is still found by dedent, which matches ordinary files; tabs are invalid YAML indentation.
- **Decision:** Keep (plan-review S1).

## Summary
The four gaps from the change are closed with tests for each; no dependency was added.
