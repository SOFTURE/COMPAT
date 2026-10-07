---
change_id: error-codes-layer
title: "New error-codes layer: typed error codes the revision adds that live client builds cannot translate"
status: archived
roadmap_item: null
issue: 48
branch: claude/project-thread-hs0wdd
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
A new `error-codes` layer reads the typed error codes the server returns (regex sources) at the base and the
revision, and the translation map of each client at its live refs. A code that is new in the revision and that a
live client ref cannot translate is `error-code-unknown-to-client` (`needs-action`): that build shows a generic
error instead of the message. Added and removed codes are reported as `safe`.

## Context
GitHub issue #48 (PETSEO 2.2.4 -> 2.3.5 adds `Shop.Cart.NotFound`, `FeatureFlag.General.Disabled`, five
`NotificationBroadcast.*` codes and more; old mobile builds translate codes in `constants/api.ts`). The spec types
the error body as a string, so `openapi` cannot see it, and `persisted-enums` covers stored enums only. Client refs
reuse `refListSchema` and `resolveRefList` from `src/resolve/ref-list.ts` (#41, PR #60).

## Constraints
- Fail closed: a code source or client map that matches no file or yields no code fails the layer; never a guess.
- No dependency on other layers' modules (same rule as #41).
- English in everything committed.

## Notes
- 2026-10-07: opened from issue #48.
- 2026-10-07: implemented on branch claude/project-thread-hs0wdd; gates green (typecheck, lint, 1034 tests, test:pack); archived.
