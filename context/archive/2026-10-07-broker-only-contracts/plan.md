# Plan: broker-only-contracts

## Decisions
- A candidate folder is kept when its name ends with `Messages` or `Events`, or when a C# file of the
  repository names one of the folder's declared types in a broker reference (see research). Test folders and
  build output stay ignored.
- Kept folders enable the layer; skipped folders are named in the init summary. With no kept folder but some
  candidates, the layer is written disabled with the candidates as its example, and the note says why.
- The nullability message has three forms: value type, reference type, and unknown (an external type), which
  states both outcomes.

## Steps
1. Failing tests: init skips request-DTO folders and keeps a folder named by `IConsumer<T>`; nullability
   messages for `int?`, `List<T>?`, a source enum, a source class and an external type.
2. Implement broker-reference detection in `init.ts`.
3. Implement type-kind lookup and the three messages in `compare-contracts.ts`; update the README row.
4. Run typecheck, lint and tests.

## Progress
- [x] 1. Failing tests added (3 fail on master).
- [x] 2. init selects broker folders.
- [x] 3. Nullability message by type kind; README rows updated.
- [x] 4. `npm run typecheck`, `npm run lint`, `npm test` green.
