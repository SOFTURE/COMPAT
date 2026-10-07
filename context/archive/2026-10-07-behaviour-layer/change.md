---
change_id: behaviour-layer
title: "behaviour: run the base ref's black-box tests against the revision's stack"
status: archived
roadmap_item: issue #22
branch: claude/project-thread-vwsmdu
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
Changes no static layer can see (refactored worker jobs, query-string binding, push payloads) are caught by running
the **base** ref's black-box tests against the **revision**'s running system. A base test that fails there is a
`breaking` finding `base-test-failed`.

## Context
PETSEO `2.3.4` rewrote worker jobs to specifications (research F12), switched number parsing from
`NumberStyles.Any` to `NumberStyles.Float` (F3) and changed push payloads opened by old app versions (F11). Listed as
`behaviour` in `context/backlog/later-layers.md`. The background process helper from issue #11
(`src/process/background-process.ts`) gives guaranteed stops and is reused here.

## Constraints
- Stack-agnostic: the layer only orchestrates consumer commands (`start`, `test`, `stop`).
- `stop` always runs, also after failures and timeouts; no child process survives.
- Results come from JUnit XML or TRX; no new runtime dependency.
- `retries`, `baseline` and `accept` by test name pattern, as proposed in the issue.

## Notes
- Archived 2026-10-07: `behaviour` layer (`src/layers/behaviour/`), JUnit XML and TRX readers without a new
  dependency, `init` starter entry (disabled), README section.
- `start` supports both a script that exits (the issue's example) and `background: true` with a `ready` URL (the
  fixture's tiny server), reusing the issue #11 background process helper.
