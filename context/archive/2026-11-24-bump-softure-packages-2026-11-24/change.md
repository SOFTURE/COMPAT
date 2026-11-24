---
status: archived
roadmap_item: null
---

# Change: bump-softure-packages-2026-11-24

Source: the nightly package-update routine (`routines/package-updates.md` in `@softure-ai/skills`).
Move every `@softure-ai/*` package to its newest published version and keep `context/` green under the doctor.

Scope: `@softure-ai/skills` 0.33.0 -> 0.34.0 (the only `@softure-ai/*` dependency), the doctor pin in
`.github/workflows/ci.yml`, the managed block in `AGENTS.md`, `context/state.json`.
Out of scope: releasing, tagging, publishing or deploying.

## Notes
- research skipped: a dependency bump; the package diff 0.33.0..0.34.0 and the doctor run are the research (plan.md).
- Branch: the session's designated branch; the harness allows pushes only there.
