# Plan: config-chains

Input: change.md, issue #19. Complexity: medium (1 phase; layer-local).

## Goal
- A key added to compose, the Ansible template and `deploy-dev` but not to `deploy-prod` gives one
  `config-chain-missing` finding naming `deploy-prod`.
- The same key present in every source of the chain gives no finding.

**Out of scope:** `presence` (#20), comparing values or defaults across sources.

## Research (summary)
- `config-layer.ts` scans each source at both refs and merges the per-source indexes into one base and one revision
  index; the per-source indexes are already keyed by identity (`getKeyIdentity`, #18).
- `applyAccept` in `classify.ts` matches `{ key, id }`; chain entries need `{ key, chain }`.
- #20 edits the same three files, so new logic goes to `chains.ts` and the existing files only gain wiring.

## Key decisions
| Decision | Choice | Why |
| --- | --- | --- |
| Members | `sources` plus `required`; together at least two distinct names, all declared in `sources` of the layer | a chain of one source checks nothing; typos fail at load time |
| Missing | a key present in the revision of one member and absent from the revision of another | the issue's rule; presence only, values are not compared |
| Class | `breaking` when a `required` member misses the key, else `needs-action`; `class` on the chain overrides both | issue: configurable per chain |
| Scope | `"changed"` (default): the key's declarations differ between refs in at least one member (added, removed, default changed); `"all"`: every key | old asymmetries do not flood every report; `all` is the audit mode |
| Finding | id `config-chain-missing`, scope `chain <name>`, subject the key identity, message lists the sources that have the key and the ones that miss it; evidence from the members that have it | one finding per key and chain |
| Accept | `accept[]` also takes `{ key, chain, reason }`, matched by key identity and chain name | issue's shape; any spelling works like other accept entries |
| Failed source | a chain with a member that failed to scan is skipped with a note; the layer already fails | missing data must not invent missing keys |
| Module | `chains.ts` holds the check; `config.ts` the schema; `config-layer.ts` keeps per-source scans and calls it | small diff in files #20 also edits |

## Progress

> `- [x]` pending, `- [x]` done.

### Phase 1: chains

#### Automated
- [x] 1.1 `config.test.ts`: chain schema (unknown source, fewer than two members, duplicates, chain accept entry)
- [x] 1.2 `chains.test.ts`: missing member, all present, required gives breaking, class override, scope changed vs all, accept
- [x] 1.3 `config-layer.test.ts`: issue #19 acceptance (deploy-prod missing; all present gives nothing)
- [x] 1.4 Gates green (typecheck, lint, test); README config section updated
