---
status: archived
roadmap_item: null
---

# Change: close-roadmap-v2

Source: the owner's word of 2026-11-24: close roadmap v2 now.

Roadmap v2 (CMP-7..CMP-12) is fully merged and released, but `context/foundation/roadmap.md` still holds it because
its header says "Archive roadmap: no", so every reader of `context/state.json` shows it as the active roadmap.

Scope: verify each row against `master` and the releases, record the evidence, close the roadmap
(`softure-roadmap --close`: `## Summary` with merge SHAs and the release, file moved to
`context/foundation/archive/`), regenerate `context/state.json`, doctor exits 0.
Out of scope: releasing, tagging, publishing or deploying; any source change; a new roadmap.

## Notes
- research skipped: the evidence (merge commits, GitHub Releases, release runs, npm) is gathered in plan.md.
- Branch: the session's designated branch; the harness allows pushes only there.
