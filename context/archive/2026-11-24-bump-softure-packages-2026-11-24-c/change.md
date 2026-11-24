---
status: archived
roadmap_item: null
---

# Change: bump-softure-packages-2026-11-24-c

Source: owner-word issue #144 (bump `@softure-ai/skills` to 0.37.0 or newer through the package-update routine,
settle owner-queue entries answered "later" under the 0.37.0 rule, doctor clean, no release).
Move `@softure-ai/skills` to its newest published version and keep `context/` green under the doctor.

Scope: `@softure-ai/skills` 0.36.0 -> 0.37.0 (the only `@softure-ai/*` dependency), the doctor pin in
`.github/workflows/ci.yml`, the managed block in `AGENTS.md`, `context/state.json`.
Out of scope: releasing, tagging, publishing or deploying.

## Notes
- research skipped: a dependency bump; the installer output, the managed-block diff and the doctor run are the research (plan.md).
- Third package-update change of the day, hence the `-c` suffix on the change-id.
