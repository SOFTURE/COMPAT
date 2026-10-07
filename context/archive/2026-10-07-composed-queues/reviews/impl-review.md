# Implementation review: composed-queues

Verdict: approved.

- `compose-queues.ts` is pure (part values to names) and covered by unit tests: product, default fallback, source
  over default, evidence site, a repeated placeholder, the 1000-name limit.
- The layer scans regex sources first, then builds composed ones, so a part may be declared after its composed
  source. A part source that failed to scan skips the composed source with an error instead of reporting every
  queue as removed.
- Schema: placeholders and `parts` keys must match, parts must name `regex` sources of the same list, and at least
  one part must read a source; each case has a rejection test.
- e2e (`test/e2e/composed-queues.test.ts`): a new group gives `PETSEO.Worker.Sync.Digest` only; a separator change
  from `-` to the default `.` removes and re-adds every group queue.
- Gates: typecheck, lint and the full test suite pass. README section documents the shape, limits and the
  library-default caveat. No non-English text in the diff.
