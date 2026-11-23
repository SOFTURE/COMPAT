---
status: archived
roadmap_item: null
---

# Change: bump-softure-packages-2026-11-23

Source: the package-update routine (`routines/package-updates.md` of `@softure-ai/skills`), run on demand.
Move every `@softure-ai/*` package and SOFTURE pin to the newest published version.

Scope: `@softure-ai/skills` 0.24.0 -> 0.30.0 (the only `@softure-ai/*` dependency), the doctor pin in
`.github/workflows/ci.yml`, the managed block in `AGENTS.md` and `context/state.json`.
Out of scope: releasing, tagging, publishing or deploying.

## Notes
- research skipped: a dependency bump; the release notes v0.25.0..v0.30.0 of SOFTURE/skills are the research and
  are summarised in plan.md.
- Branch: the session's designated branch instead of `claude/bump-softure-<date>`; the harness allows pushes only there.
