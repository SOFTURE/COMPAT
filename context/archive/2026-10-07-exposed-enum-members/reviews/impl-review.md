# Implementation review: exposed-enum-members

Reviewed the diff against plan.md and issue #15.

## Checked
- Acceptance: `test/e2e/exposed-enums.test.ts` runs `persisted-enums` + `client-usage` without `openapi`: the
  exposed finding appears next to `enum-member-added`, drops to `safe` with the client as evidence when the live ref
  only renders the field, and stays `needs-action` citing the `switch` line when an older live ref switches on it.
- Fail direction: no `sources`, an exposing API without a client, a tokenizer miss (unclosed template literal, a
  branch inside a template hole) all keep `needs-action`. Comments are excluded from both the token scan and the
  raw-text net.
- Contract: refinement goes through the #14 `revisions` path; the guard now also pins `exposure`. The registry moves
  `client-usage` after `persisted-enums`, still after `openapi`.
- `message-contracts` accept ids are unchanged; only `persisted-enums` accepts `enum-member-exposed-added`.

## Findings
- Fixed during review: the raw-text net first flagged every line with any bracket; it now needs an index access
  ending in the property (`[x.type]`), and it only counts occurrences the tokenizer did not read as identifiers,
  so ordinary JSX attributes such as `type="submit"` next to a comparison do not count.
- Accepted limitation: branch detection is per property name, not per DTO type; a `switch` on an unrelated `type`
  property keeps the finding at `needs-action` (the safe direction). Documented in README.
- Out of scope (plan): auto-detecting exposure from the spec.

Verdict: ready.
