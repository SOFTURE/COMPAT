# Plan: seed-enum-members

Input: change.md, issue #71. Complexity: low.

## Goal
Seed rows that write a string-stored enum member new in the revision are `rollback-risk`, and the
`enum-member-added` finding points at them.

**Out of scope:** the optional `enumColumns` config (which column holds which enum); int storage, where a number in a
row cannot be tied to an enum without that config.

## Approach
**Chosen:** `persisted-enums` already runs after `seed`, so it refines seed findings through `FindingRevision`, like
`client-usage` refines `openapi`. `seed` records the string literals of the rows of each `row-added` and
`row-changed` finding in a new `literals` field of `Finding`; `persisted-enums` matches them against the stored value
of each added string member.
Rejected: a separate correlation layer - one more registry entry for one rule.

**Key decisions:**
| Decision | Choice | Why |
| --- | --- | --- |
| Granularity | the whole seed finding (one per table and rule) | revisions cannot split a finding; the message names the members |
| Match | exact string literal equal to the stored value (`stringValue ?? name`) | what EF string conversion stores |
| `literals` on revision | fixed, like `exposure` | a refinement cannot change what a finding is about |
| Seed message | drops "old builds ignore rows they do not know" and appends the member and the rollback consequence | the safe reason no longer holds |

## Phase 1: Correlate seed rows with added enum members
**Discipline:** TDD. **Files:** `src/model/finding.ts`, `src/layers/revisions.ts`, `src/layers/seed/classify.ts`,
`src/layers/persisted-enums/compare-enums.ts`, `src/layers/persisted-enums/persisted-enums-layer.ts`,
`src/layers/persisted-enums/refine-seed.ts`, `src/layers/registry.ts`, `test/e2e/seed-enum-members.test.ts`,
`test/layers/revisions.test.ts`, `README.md`

1. E2E test first: both layers run; the `TermsChange` seed rows are `rollback-risk` with the `NotificationType.cs`
   declaration as evidence; a seed row of another table whose literals match no added member stays `safe`; the
   `enum-member-added` message says the seed writes it on deploy, with the seed row as evidence.
2. Implement; a revision that changes `literals` is rejected.
3. README `### seed` and `### persisted-enums`.

**Done when:**
- Automated: the cases above pass; gates green (typecheck, lint, test).

## Progress

> `- [ ]` pending, `- [x]` done. A phase ends with ` — <commit sha>` on its done items. Never rename items.

### Phase 1: Correlate seed rows with added enum members

#### Automated
- [x] 1.1 Every listed case passes in `test/e2e/seed-enum-members.test.ts` and `test/layers/revisions.test.ts`
- [x] 1.2 Gates green (typecheck, lint, test)
