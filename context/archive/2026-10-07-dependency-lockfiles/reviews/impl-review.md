# Implementation review: dependency-lockfiles

Verdict: ready. Gates: `npm run typecheck`, `npm run lint`, `npm test` (891 passed, 22 skipped locally: oasdiff and
docker tests, forced in CI), `npm run build && npm run test:pack`.

- Acceptance: `test/e2e/dependency-lockfiles.test.ts` keeps `package.json` at `^4.1.0` while `package-lock.json`
  moves 4.1.0 → 4.9.0 (`safe`, `resolved from lockfile`, evidence on the lockfile line), reports a watched
  `amqplib` installed under another package as `needs-action` with `transitive`, migrates a pnpm workspace from
  lockfile 6.0 to 9.0, reads NuGet `Direct` and watched `CentralTransitive` entries, and fails on pnpm
  `lockfileVersion '10.0'` naming the file. `lockfiles: false` brings back the declared-range comparison.
- Unit tests cover npm lockfile v1 and v3 (node resolution from a workspace folder, links skipped), pnpm 5.x, 6.x and
  9.x (peer suffixes, quoted keys, `link:` versions), NuGet v2 and `preferResolved`.
- Large lockfiles: JSON is parsed once and key offsets are collected in one regex pass; line numbers use a binary
  search over line starts. pnpm YAML is read line by line and keeps only importer entries and `packages` keys.
- `findObjectKeys` keeps the first `"key": {` per key. In an npm v1 lockfile a nested copy listed before the hoisted
  one points the evidence line at the nested copy; the version is right. Accepted for a legacy format.
- The pnpm reader understands the block layout pnpm writes; a hand-written lockfile in flow style would read no
  importers and fall back to declared versions, not crash.
- `read-nuget.ts` (CMP-9) is not touched.
