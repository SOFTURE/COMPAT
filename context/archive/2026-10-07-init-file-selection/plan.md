# Plan: init-file-selection

Input: change.md, issue #46. Complexity: small (1 phase; `init` only).

## Goal
- On a PETSEO-like repository, `init` writes the production compose file and the server `.env` example only,
  skips `TESTS/` compose files and the Expo app's `.env.example` and `package.json`, and says so on stderr.
- With NuGet, `dependencies.ignore` lists the test packages of the issue.
- Ansible templates, env lookups, asserts and workflow secrets become regex sources; one `deploy` chain has the
  assert as `required`; a workflow `environment: production` adds `gh secret list --env production`.
- `check` runs the written config: a key added to the template but not to the assert is `config-chain-missing` `breaking`.

## Research (summary)
- `RefTree.listFiles` globs have no negation, so a narrowed selection is written as an explicit `files` list;
  a source keeps its default files when nothing was left out (existing configs stay identical).
- The config layer fails a regex source that finds no key, so `init` scans each candidate file with the same
  `compileRegexSource` and `scanRegex` and lists only files with a key.
- Chains (#19) and presence (#20) already exist; `init` only writes them.

## Key decisions
| Decision | Choice | Why |
| --- | --- | --- |
| Placement | new `init-selection.ts`; `detectConfig` and `detectDependencies` in `init.ts` call it | #44 and #45 change other functions of `init.ts` in parallel |
| Test files | folders `test(s)`, `e2e`, `mocks`, `__tests__`, `__mocks__`, `*.Tests`; or such a word in the file name | the issue's folders plus `docker-compose.integration-tests.yml` style names |
| Mobile app | folder of a `package.json` with `expo` or `react-native` in dependencies or devDependencies; a root manifest claims no folder | the issue's rule; a root RN app would otherwise hide every file |
| Deploy compose | file names in Ansible YAML and workflows (`-f`, `src:`) and `project_src` folders, matched by path suffix after the last templated or `..` segment; a bare name picks the nearest file | references are relative to where the tooling runs |
| Preference | referenced compose files replace the rest; the rest are listed as skipped | the issue: prefer the deployed files |
| Ansible scope | folders `ansible`, `roles`, `playbooks`, or below an `ansible.cfg`; `.j2` also under any `templates` folder | no false Ansible matches in application YAML |
| Workflow keys | upper-case `KEY: ${{ secrets.X }}` lines | lower-case `with:` inputs (`token`, `password`) are not configuration keys |
| Chain | `deploy`: compose (only when deploy-referenced) plus every deploy source but the assert; the assert as `required` | the issue: one chain, assert required |
| Presence | a workflow `environment:` named like `prod` first, else the first by name | `gh secret list --env` needs one environment |
| Ignore | written only when a NuGet source exists | the defaults are NuGet names |

## Progress

> `- [ ]` pending, `- [x]` done.

### Phase 1: file selection and deploy chain

#### Automated
- [x] 1.1 `init.test.ts`: test and mobile compose/dotenv skipped; mobile `package.json` skipped (and layer disabled when it is the only one); NuGet ignore
- [x] 1.2 `init.test.ts`: deploy chain sources, chain, presence; nearest bare compose name; quoted templated `project_src`
- [x] 1.3 `init.test.ts`: init, commit a template-only key, check reports `config-chain-missing` `breaking`
- [x] 1.4 Gates green (typecheck, lint, test); README `init` table documents the selection
