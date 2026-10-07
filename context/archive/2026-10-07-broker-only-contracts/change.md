---
change_id: broker-only-contracts
title: "init keeps only broker contract folders; nullability text follows the type kind"
status: archived
roadmap_item: issue #45
branch: claude/project-thread-r2phjy
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
`init` enables `message-contracts` only for contract folders whose types travel through the broker, and
`message-property-nullability-changed` explains the risk that matches the property's type kind.

## Context
On PETSEO `init` picked five `*Contract*` folders; four hold HTTP request DTOs that `openapi` already covers,
which produced 55 findings instead of 4 on `2.2.4 -> 2.3.5` (issue #45). The nullability message always
described a value-type failure, also for `List<DayOfWeek>? -> List<DayOfWeek>`.

## Constraints
- Folder discovery globs stay as they are; only the selection among found folders changes.
- Classes of findings stay as they are; only the nullability message changes.
- English in everything committed.

## Notes
- Archived 2026-10-07: `detectMessageContracts` in `src/commands/init.ts` keeps a folder when its name ends with
  `Messages`/`Events` or a broker API names one of its types; skipped folders are listed in the init summary, and
  with none kept the layer is written disabled with them as the example. `compare-contracts.ts` picks one of
  three nullability texts (value, reference, unknown) from the C# keywords, BCL structs and the source
  declarations of both refs.
