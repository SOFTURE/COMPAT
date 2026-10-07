# Plan: composed-queues

Input: change.md, issue #47. Complexity: medium (1 phase; layer-local).

## Goal
- With `rabbit-endpoint` (`PETSEO.Worker.Sync` from `appsettings.json`), `consumer-groups` (`Broadcast` from
  `ConsumerGroups.cs`) and a `composed` source `{endpoint}{separator}{group}` with separator default `.`, a new group
  gives one `queue-added` finding for `PETSEO.Worker.Sync.Broadcast`, and no finding for the raw parts when they are
  marked `report: false`.
- A separator that changes from `-` to `.` (from a configured source) gives `queue-removed` for every old group queue
  and `queue-added` for every new one.

**Out of scope:** reading a library's built-in default separator per package version (the `dependencies` layer
reports the upgrade); composing from `composed` sources; `prefix` on regex sources.

## Research (summary)
- `message-contracts-layer.ts` scans each regex queue source at both refs into `QueueScan { files, queues: Map<name,
  Site> }`, checks coverage, then `compareQueues` gives `queue-added` / `queue-removed` with evidence from the site.
- `queueSourceSchema` is a single `regex` object; `queues[]` checks unique names only. Zod 4 lets a
  `discriminatedUnion` take refined objects.
- The README test (`test/readme.test.ts`) checks finding ids per layer section; new ids are not needed.
- The e2e PETSEO fixture (`test/e2e/message-contracts.test.ts`) already has the literal-name case; the layer has no
  unit test file, so the composition logic goes to its own module with its own tests.

## Key decisions
| Decision | Choice | Why |
| --- | --- | --- |
| Shape | `{ kind: "composed", name, template, parts }`; `template` uses `{part}` placeholders, everything else is literal | the issue's shape |
| Part | a queue source name, or `{ source?, default? }` with at least one of them | a separator is either configured or a library constant |
| Part values at a ref | every name the part source found at that ref; `default` when it found none; a part with only `default` is that constant | the separator key is often absent from `appsettings.json` |
| Names | one queue per combination of part values (cartesian product), deduplicated | the issue: one queue per combination |
| Limit | more than 1000 combinations at one ref fails the source | a too-broad pattern must not explode the report |
| Part sources | must be `regex` sources declared in `queues`; at least one part has a `source`; placeholders and `parts` keys match exactly | typos fail at load time; a fully constant name is a regex job |
| Raw parts | regex sources get `report` (default `true`); `false` keeps them scanned and file-checked but gives no finding and may find no name at a ref | otherwise `PETSEO.Worker.Sync` and `Broadcast` are reported as queues; a separator left to its default finds nothing |
| Evidence | the site of the last part (in template order) whose value came from a source at that ref | the most specific part, usually the group constant |
| Failures | a part source that failed to scan skips the composed source with an error naming it; coverage like regex (no queue at either ref, queues at the base but none in the revision) | missing data must not invent removed queues |
| Module | `compose-queues.ts` (pure: values to names), wiring in `message-contracts-layer.ts` | testable without git fixtures |

## Progress

> `- [ ]` pending, `- [x]` done.

### Phase 1: composed queue source

#### Automated
- [x] 1.1 `config.test.ts`: composed schema (unknown part source, part pointing at a composed source, placeholder
  without a part, part not in the template, part with neither source nor default, constant-only parts), `report` default
- [x] 1.2 `compose-queues.test.ts`: product, default fallback, constant part, dedupe, evidence site, combination limit
- [x] 1.3 e2e `composed-queues.test.ts`: issue #47 acceptance (new group gives the composed name; separator change
  renames every group queue; `report: false` hides raw parts)
- [x] 1.4 Gates green (typecheck, lint, test); README message-contracts section updated
