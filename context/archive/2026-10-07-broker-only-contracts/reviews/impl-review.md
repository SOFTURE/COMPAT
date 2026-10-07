# Implementation review: broker-only-contracts

- Tests added first and confirmed failing on master (3 failures), green after the change.
- `readTypeArguments` stops at `;` or `{`, so a stray `Send <` comparison cannot swallow a file.
- Type names found in comments may keep a folder; that errs towards enabling, which the user reviews anyway.
- A simple name declared both as a value and a reference type in the sources reads as unknown.
- Gates: `npm run typecheck`, `npm run lint`, `npm test` (879 passed, 22 skipped) green.
