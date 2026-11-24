---
status: archived
roadmap_item: null
---

# Change: bump-softure-packages-2026-11-24-b

Source: an on-demand run of the package-update routine (`routines/package-updates.md` in `@softure-ai/skills`),
together with the owner-word wake declaration.
Move every `@softure-ai/*` package to its newest published version, declare `autonomy.ownerWordWake`, and keep
`context/` green under the doctor.

Scope: `@softure-ai/skills` 0.34.0 -> 0.36.0 (the only `@softure-ai/*` dependency), the doctor pin in
`.github/workflows/ci.yml`, the managed block in `AGENTS.md`, `context/workflow.json` (`autonomy.ownerWordWake`),
`context/state.json`, the repository label `owner-word`.
Out of scope: releasing, tagging, publishing or deploying; creating or editing scheduled tasks.

## Notes
- research skipped: a dependency bump; the installer output, WORKFLOW §2/§8.6 and the doctor run are the research (plan.md).
- Second package-update change of the day, hence the `-b` suffix on the change-id.
