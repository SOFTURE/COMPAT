# Plan: new-table-followup-message

1. Add a failing test: a unique index and explicit-id inserts on a new table produce messages without
   "start failing" or "precondition".
2. In `classify.ts`, replace the prefixing `describeMessage` with a per-rule neutral action for new-table
   findings; merged explicit-id inserts keep the neutral message.
3. Run typecheck, lint and tests.

## Progress
- [x] 1. Failing test added (fails on master).
- [x] 2. Neutral new-table messages implemented.
- [x] 3. `npm run typecheck`, `npm run lint`, `npm test` green.
