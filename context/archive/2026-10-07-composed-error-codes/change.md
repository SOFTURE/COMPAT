---
change_id: composed-error-codes
title: "Error codes composed at runtime from parts found by other code sources"
status: archived
roadmap_item: null
issue: 68
branch: issue-68
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
`error-codes` reads codes only from literal strings. PETSEO declares a generic
`RepositoryErrors<TEntity>.NotFound` as `$"{typeof(TEntity).Name}Repository.NotFound"`, so every
`RepositoryErrors<X>` usage returns `XRepository.NotFound` and a new usage is a false negative. A `composed` code
source builds those codes from the captures of other code sources, mirroring the `composed` queue source of
`message-contracts`.

## Context
GitHub issue #68. A parallel change edits `accept[]` and adds `returnedBy` in the same layer, so this diff stays
inside the code sources.

## Constraints
- Owns `src/layers/error-codes/` (config, layer, a new module), its tests and the README section.
- Existing configs without `kind` keep working.
- English in everything committed.

## Notes
- 2026-10-07: opened from issue #68 and implemented on branch issue-68.
