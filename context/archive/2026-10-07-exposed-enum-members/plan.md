# Plan: exposed-enum-members

Input: change.md, issue #15. Complexity: medium (config field and finding in one layer, a refinement in another,
a registry order change, README).

## Goal
```json
{ "kind": "named", "name": "NotificationType", "storage": "string",
  "exposed": [{ "api": "b2c", "fields": ["NotificationDto.type"] }] }
```
Acceptance (issue #15):
- enum stored as string, exposed as a string DTO field, member added → `enum-member-exposed-added` next to
  `enum-member-added`;
- with a client whose sources `switch` on the field → the finding stays and cites the switch; without it → `safe`.

**Out of scope:** auto-detecting exposure from spec property names and descriptions (optional in the issue; a
name match is too weak to be the only signal); removed or renamed members of exposed enums (already `breaking`).

## Approach
| Decision | Choice | Why |
| --- | --- | --- |
| Config | `exposed?: [{ api, fields: ["Type.property", ...] }]` on `named` entries only | discovery covers many enums at once; exposure is per enum |
| Finding | one `enum-member-exposed-added` per added member, `needs-action`, same subject and evidence as `enum-member-added`, plus `Finding.exposure` (`{ api, fields }[]`) | the refiner needs the API and fields as data, not parsed from a message |
| Accept | the id is accepted by `persisted-enums` `accept` only, not by `message-contracts` | message-contracts never produces it |
| Revision guard | a revision must also keep `exposure` | a refiner may not retarget a finding |
| Registry order | `client-usage` moves after `persisted-enums` (still after `openapi`) | a refiner runs after what it refines |
| No openapi | `client-usage` fails only when neither `openapi` nor `persisted-enums` ran; openapi skipped → its part skipped | enum refinement does not need openapi |
| Branch detection | in the client `sources` (generated client excluded) at every live ref: `switch (...)` over the field or the enum, `===`/`!==`/`==`/`!=` with an operand chain ending in the field or naming the enum, `case Enum.X`, `Record<Enum, ...>` / `Record<..."field"...>`, `[k in Enum]`, index access `[x.field]`; property name compared case-insensitively | the issue's switch, equality and lookup-map forms |
| Safety net | a raw line (comments blanked) holding `switch`, `case`, an equality operator, `Record<` or `[...field]` together with the field or enum word is a branch site too | a tokenizer miss must never read as "does not branch" |
| No sources | a client of the API without `sources` cannot prove absence: the class stays and the message says so | fail toward `needs-action` |
| No client for an API | the finding is left alone; a note names the API | nothing to refine |

## Progress
- [x] Phase 1: persisted-enums config, finding, accept ids, `Finding.exposure`, revision guard
- [x] Phase 2: client-usage branch scanner, enum refinement, registry order
- [x] Phase 3: unit tests, layer tests, acceptance test, README
- [x] Gates: typecheck, lint, test (828), build, test:pack
