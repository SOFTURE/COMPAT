# Plan review: dependency-lockfiles

Verdict: ready.

- Precedence per package and ref is coarse: a repository where one project has a lockfile and another declares the
  same package without one compares only the resolved versions. Lockfiles are normally enabled repository-wide
  (`RestorePackagesWithLockFile` in `Directory.Build.props`, one npm/pnpm root), so this is accepted and documented.
- Base without a lockfile and revision with one compares the declared lower bound with the resolved version, and a
  watched transitive package shows as `dependency-added`. True to what changed at runtime; documented.
- Failing on an unknown `lockfileVersion` could break a run that passes today; `lockfiles: false` is the way out and
  the error names it.
- `read-nuget.ts` (CMP-9) is not touched; the layer entry point is, so whichever merges second merges `master` in.
