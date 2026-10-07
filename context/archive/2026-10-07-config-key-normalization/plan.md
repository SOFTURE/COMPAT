# Plan: config-key-normalization

Input: change.md, issue #18. Complexity: medium (1 phase; layer-local).

## Goal
- `SHOP_BASE_URL` in compose, `Shop__BaseUrl` in an Ansible template and `public required string BaseUrl` in
  `ShopSettings.cs` yield one `config-key-added-required` finding with three evidence entries.
- Two settings classes with a `BaseUrl` member stay two keys.

**Out of scope:** `chains` (#19), `presence` (#20), reading `appsettings*.json` structure.

## Research (summary)
- `classify.ts` indexes declarations by `declaration.key`; `classifyKeys` iterates the index keys, so changing the
  index key to an identity merges spellings without touching the per-file comparison units.
- `scan-regex.ts` reads only the group `key`; `config.ts` requires that group at schema time.
- `applyAccept` compares `entry.key === finding.subject`.

## Key decisions
| Decision | Choice | Why |
| --- | --- | --- |
| Normalization | split on every non letter or digit character and on case changes (`aB`, `1B`, `ABc`), lowercase the words | covers `:`, `__`, `.`, `_`, `-`, PascalCase and camelCase; acronyms stay one word |
| Canonical form | words joined by `_` in upper case (`SHOP_BASE_URL`) | the environment variable and secret store spelling; #20 compares against secret names |
| Default | `keyMatching: "normalized"`; `"exact"` restores the old comparison | the issue's behaviour by default, an escape hatch for case-sensitive keys |
| Subject | the identity (canonical key in normalized mode) | stable across spellings; accept entries are normalized the same way |
| Spellings | appended to the message as `(spelled A, B)` when any spelling differs from the subject | the issue asks to keep original spellings; evidence has no free-text field |
| Key template | regex `key: "{section}__{member}"`; placeholders are named groups of `pattern` or `enclosing` | builds .NET section plus member keys without code |
| Enclosing | `enclosing` pattern; the nearest match starting before the key lends its groups; the match's own group wins | `class (?<section>\w+)Settings` around members; nearest-preceding is cheap and predictable |
| Unfilled placeholder | becomes empty; an empty key is skipped | dropping the declaration would hide a required key |
| Validation | template needs at least one placeholder; every placeholder is a known group; `enclosing` without a template or unused by it fails | config typos fail at load time |
| Prefix | optional on every source kind, prepended literally | normalization makes `Shop`, `Shop__` and `Shop:` equivalent |
| Reuse | `src/layers/config/keys.ts`: `splitKeyWords`, `normalizeKey`, `getKeyIdentity` | #19 and #20 build on it |

## Progress

> `- [ ]` pending, `- [x]` done.

### Phase 1: normalization, key templates, prefix

#### Automated
- [x] 1.1 `keys.test.ts`: spellings collapse, acronyms and digits, different settings stay apart
- [x] 1.2 `scan-regex.test.ts`: template over one match, enclosing nearest match, own group wins
- [x] 1.3 `config.test.ts`: keyMatching default, prefix, template and enclosing validation
- [x] 1.4 `config-layer.test.ts`: issue #18 acceptance (one finding, three evidence entries; two `BaseUrl` classes stay two keys; exact mode; prefix and accept by any spelling)
- [x] 1.5 F10 end to end: four findings instead of six, `SHOP_BASE_URL` evidence from Ansible, compose and .NET
- [x] 1.6 Gates green (typecheck, lint, test); README config section updated
