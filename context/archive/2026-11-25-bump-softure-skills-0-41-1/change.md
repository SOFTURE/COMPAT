---
status: archived
roadmap_item: null
---

# Change: bump-softure-skills-0-41-1

Source: the owner's word in the project chat (bump `@softure-ai/skills` to the latest version through the
merge path, then set up the COCKPIT command routine).
Move `@softure-ai/skills` to its newest published version and keep `context/` green under the doctor.

Scope: `@softure-ai/skills` 0.37.0 -> 0.41.1 (the only `@softure-ai/*` dependency), the doctor pin in
`.github/workflows/ci.yml`, the managed block in `AGENTS.md`, the obsolete `autonomy.ownerWordWake` key in
`context/workflow.json`.
Out of scope: releasing, tagging, publishing or deploying; the COCKPIT command task (it writes nothing to the
repository).

## Notes
- research skipped: a dependency bump; the installer output, the managed-block diff and the doctor run are the research (plan.md).
