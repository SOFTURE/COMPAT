# Plan: enum-branch-operands

Input: change.md, issue #69. Complexity: small (one field on the finding, the branch scanner, README).

## Goal
Acceptance (issue #69):
- a client whose only matches are `event.type === 'set'` and `key.toLowerCase() === 'content-type'` turns
  `enum-member-exposed-added TermsChange` into `safe` with `no live client ref branches on NotificationDto.type`;
- `switch (n.type) { case 'Unknown': ... }`, with `Unknown` a member, still counts as a branch.

**Out of scope:** the optional `branchFiles` setting from the issue.

## Approach
| Decision | Choice | Why |
| --- | --- | --- |
| Member values | `Finding.enumValues`: member names and string values at both refs, set by `persisted-enums` on `enum-member-exposed-added`; passed to the scanner as `BranchTarget.values` | the scanner needs them as data; the branch key stays enum + properties |
| Matching | case-insensitive | a serializer naming policy may camel-case the values; a near miss must count |
| Equality | not a branch when the other operand is a plain string literal (no holes) naming no member and no tighter-binding operator (`+`, `.`, `(`, ...) touches it | `"se" + x` or `"set".toUpperCase()` are expressions the scanner cannot read |
| Switch | not a branch when the head does not name the enum and every `case` label is such a literal (at least one) | `default` alone or any other label fails closed |
| Raw-text net | words inside one-line plain string literals count as read | `'content-type'` is never the property |
| No values | every comparison counts, as before | fail closed |

## Progress
- [x] Tests first: scanner unit tests, layer acceptance fixtures, `enumValues` on the finding
- [x] `Finding.enumValues`, `BranchTarget.values`, scanner rules, raw-text net
- [x] README
- [x] Gates: typecheck, lint, test (1080)
