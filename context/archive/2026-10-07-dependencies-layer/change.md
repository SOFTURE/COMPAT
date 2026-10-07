---
change_id: dependencies-layer
title: "Runtime dependency upgrades are reported with a semver-based class"
status: archived
roadmap_item: null
issue: 17
branch: claude/project-thread-09kzoz
created: 2026-10-07
updated: 2026-10-07
archived_at: 2026-10-07
---

## Intent
`softure-compat check` gets a `dependencies` layer. It diffs the runtime dependencies declared at both refs
(NuGet: `Directory.Packages.props`, `*.csproj` and other MSBuild files; npm: `package.json`) and reports added,
removed, upgraded and downgraded packages. A major upgrade, or a minor upgrade of a `0.x` package, is
`needs-action`; patch and minor upgrades are `safe`. A `watch` list raises the class of packages that matter at
runtime, `ignore` drops analyzer and test packages, `accept` works as in other layers.

## Context
GitHub issue #17. PETSEO `2.2.4 → 2.3.4` bumped `SOFTURE.MessageBroker.Rabbit` `0.4.0 → 1.2.0`, which replaced the
retry policy (research F9); it was found only by reading `APP/Directory.Packages.props` by hand.

## Constraints
- Owns `src/layers/dependencies/`. Touches the layer registry, the `init` starter config and the README with one
  entry each.
- No network, no new runtime dependency. English in everything committed.

## Notes
- 2026-10-07: opened from issue #17.
- 2026-10-07: implemented on branch claude/project-thread-09kzoz; gates green (typecheck, lint, 542 tests, test:pack); archived.
