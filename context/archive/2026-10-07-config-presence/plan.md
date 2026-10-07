# Plan: config-presence

Input: change.md, issue #20. Complexity: small (1 phase; layer-local).

## Goal
- A presence command printing `SHOP_API_KEY` turns that finding `safe`; `SHOP_BASE_URL` stays `needs-action`.
- A presence command printing `SHOP_API_KEY=abc` leaves no `abc` in the JSON or Markdown report.

## Research (summary)
- `config-layer.ts` classifies, then applies `accept`; presence fits between the two.
- `runProcess` (shell, timeout, process-group kill) is already used by the openapi `command` source.
- Key identities come from `getKeyIdentity` (#18), so presence names match `Shop__ApiKey` and `SHOP_API_KEY` alike.

## Key decisions
| Decision | Choice | Why |
| --- | --- | --- |
| Placement | new `presence.ts`; one field in `config.ts`, one call in `config-layer.ts`, `classify.ts` untouched | #19 edits the same files in parallel |
| Working directory | `repoDir` (the consumer's checkout), not a materialized ref | the command asks about the environment, not a revision |
| When it runs | once, only when a `config-key-added-required` or `config-key-default-removed` finding exists | no needless calls to a secret store |
| Value stripping | each line cut at the first `=`, trimmed, `export ` dropped, blank and `#` lines skipped | `op environment read` prints `KEY=value`; the value never leaves the parser |
| Errors | exit code or timeout only, never stdout or stderr | output may carry values |
| Failure | a note; findings keep their class; the layer still `ran` | the issue asks for it; presence is advisory |
| Message | the original message plus `; present in the target environment (presence command)` or `; missing ...` | keeps the reason and adds the answer |
| Order | presence before `accept` | an accept entry still matches by id and key |
| Timeout | `timeoutSeconds` 1..3600, default 60 | the issue's example |

## Progress

> `- [ ]` pending, `- [x]` done.

### Phase 1: presence provider

#### Automated
- [x] 1.1 `presence.test.ts`: parsing strips values, comments, `export`; apply turns listed keys safe, marks missing; command errors never quote output; timeout; schema
- [x] 1.2 `config-layer.test.ts`: command runs in the repository, only when a finding needs a value
- [x] 1.3 `e2e/config.test.ts`: issue #20 acceptance on the F10 fixture (SHOP_API_KEY safe, SHOP_BASE_URL needs-action); `abc` never in md or json; failing command is a note
- [x] 1.4 Gates green (typecheck, lint, test); README config section documents `presence`
