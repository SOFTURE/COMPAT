---
change_id: persisted-enums-layer
title: "Changes to enums persisted in the database are classified by how they are stored"
status: implemented
roadmap_item: CMP-4
branch: claude/project-thread-ijh43y
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
`softure-compat check` gets a `persisted-enums` layer. For every enum stored in the database (as a string or an
int), it compares members between the refs: a removed or renamed member is `breaking`, a renumbered member under
int storage is `breaking`, an added member is `rollback-risk` (once a row holds it, the older build fails to read it).

## Context
Roadmap item CMP-4. Design input: research §4 layer 5. Acceptance fixture: F7 (`NotificationType.TermsChange`
added, stored as a string via `ConfigureEnum` → `rollback-risk`; evidence `PetseoDbContext.cs:188`).

The enum list comes from the config, either by name and storage or by discovery: a file glob plus a regex with a
capture group (PETSEO: every `ConfigureEnum<T>` in the DbContext). Enum declarations are parsed in C# and
TypeScript, tolerating attributes, comments, explicit values and implicit numbering.

## Constraints
- Builds on CMP-1; independent of CMP-2, CMP-3 and CMP-5.
- Owns `src/layers/persisted-enums/`. Touches the layer registry and the config schema with one entry each.
- English in everything committed.

## Notes
- 2026-10-07: opened from roadmap v1.
- 2026-10-07: research, plan and plan review done (verdict: ready after fixes; all findings applied).
