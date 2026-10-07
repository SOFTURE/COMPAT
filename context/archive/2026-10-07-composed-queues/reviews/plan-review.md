# Plan review: composed-queues

Verdict: approved with one change.

- The goal covers both cases of issue #47 (a new group, a separator change) with an e2e acceptance test.
- `prefix` per regex source is rejected on purpose: it cannot take the separator from configuration.
- Changed during review: the plan first kept "finds no queue" checks on `report: false` sources. A separator left to
  the library default is absent from `appsettings.json`, so that check would fail every real setup. Parts now get
  file checks only; the composed source owns the "no name at either ref" check.
- Scope stays inside `src/layers/message-contracts/`; no core or report change, no new finding id.
