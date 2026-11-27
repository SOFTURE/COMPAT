---
status: archived
roadmap_item: null
---

# Change: bump-softure-skills-0-41-2

Source: cockpit issue #148 (bump `@softure-ai/skills` to 0.41.2 through the merge path and regenerate
`context/state.json` with the doctor in the same pull request).

Scope: `@softure-ai/skills` 0.41.1 -> 0.41.2 (`package.json`, lockfile), the doctor pin in
`.github/workflows/ci.yml`, a regenerated `context/state.json`.
Out of scope: everything else; releasing, tagging, publishing or deploying.

## Notes
- research skipped: a patch dependency bump; the installer output and the doctor run are the research (plan.md).
