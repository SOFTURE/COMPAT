---
status: archived
roadmap_item: null
---

# Change: bump-skills-0-33-0

Source: owner request, so that the cockpit reads this project's roadmap with the 0.33.0 roadmap parser.
Move `@softure-ai/skills` from 0.30.0 to 0.33.0 and keep `context/` green under its doctor.

Scope: `@softure-ai/skills` 0.30.0 -> 0.33.0, the doctor pin in `.github/workflows/ci.yml`, the managed block in
`AGENTS.md` and `context/state.json`. Fix any `roadmap-item-shape` finding in `context/foundation/roadmap.md`.
Out of scope: releasing, tagging, publishing or deploying.

## Notes
- research skipped: a dependency bump; the managed-block diff and the doctor run are the research (plan.md).
- Branch: the session's designated branch; the harness allows pushes only there.
