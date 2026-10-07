# Implementation review: message-contracts-layer

Reviewed: commit `ef7643c` (parser, comparison, layer, config, init detector, tokenizer change, README).
Gates re-run: `npx vitest run` 542 passed / 14 skipped, `tsc --noEmit` clean. No Polish text in the diff.
About 60 C# inputs were probed with throwaway scripts (`/tmp/claude-0/review/p1..p4.ts`). Nested generics with `>>`,
tuples, pointers, `global::`, primary constructors, constructor initializers, operators, indexers, events, local
functions in accessors, switch and collection-expression initializers, raw, verbatim and interpolated strings with
braces, static containers, nested enums and attribute targets all read correctly. Every parser failure reaches
`status: "failed"`, and unreadable names are removed from both indexes, so no failure shows up as an added or removed type.

## Verdict
**Approve with changes.** There are no critical findings. F1 and F2 are fail-open paths and should be fixed before release.

## Findings

**F1 (warning, fail-open): an interpolated constant string in an attribute is read as a literal.**
`parse-contracts.ts:639` (`readAttributeString`), `:681` (`readWireAttributes`), `tokenize.ts:162`.
`$"..."` becomes a `string` token that holds the raw hole text, so `argument.kind === "string"` accepts it.
Input (both refs): `[MessageUrn($"{Urns.Prefix}:order-placed")] public record OrderPlaced(int Id);`. When `Urns.Prefix`
changes in another file, the URN changes.
Expected: the type fails (W5: not a string literal). Actual: `urn = "{Urns.Prefix}:order-placed"`, no failure,
`(no changes)`. The same happens for `[EntityName($"...")]` and `[property: JsonPropertyName($"{P}id")]` (wire name `{P}id`).
Fix: have the tokenizer mark interpolated strings (for example `isInterpolated: true` on the token, or a distinct
kind that the enum parser treats like `string`), and make both attribute readers reject them as non-literal.

**F2 (warning, fail-open): an existing property that becomes `required` or `[JsonRequired]` is not reported.**
`compare-contracts.ts:327`: `compareType` compares only `type`, never `isRequired`.
Input: base `public record A { public string? Note { get; init; } }`, revision `... public required string? Note ...`
(or `[JsonRequired]`). Expected: `breaking` (or at least `rollback-risk`). MassTransit writes with
`DefaultIgnoreCondition = WhenWritingNull`, so a base message with a null `Note` omits the property, and the revision
consumer then fails with "missing required properties". Actual: `(no changes)`.
Fix: when `!property.isRequired && next.isRequired`, emit a finding (for example a new `message-property-required-added`
id, `breaking`) and add it to `MESSAGE_CHANGE_IDS` and the README table.

**F3 (warning): the safety net runs on raw text, so commented-out or quoted declarations fail the layer for good.**
`parse-contracts.ts:105-129`. The doc comment says "comments excluded", but `DECLARATION_LINE` runs on `text`.
Input: `namespace N;\n/*\n class Legacy\n*/\npublic record A(int X);` gives the failure
`"Legacy" at line 3 was not recognised by the parser`. A verbatim or raw string with a line that starts with
`class X` does the same. `accept` cannot suppress a layer failure, so the only way out is to edit the consumer's code.
Expected: no failure. Fix: count a regex match only when the token stream has the keyword as an identifier token on
that line. Tokens carry `line`, so build `Set<line>` of `class|struct|interface|record|enum` identifier tokens and skip
matches whose line is not in it. Alternatively, blank comments and strings before running the regex.

**F4 (suggestion): escapes in regular strings are decoded wrongly, which reports a false wire-name change.**
`tokenize.ts:67-70` (existing code in `readQuoted`): `A` becomes `u0041`.
Input: base `[property: JsonPropertyName("A")] int Id`, revision `[property: JsonPropertyName("A")] int Id`.
Expected: no change. Actual: `message-property-removed` breaking plus `message-property-added`.
Fix: share the escape decoding of `readCSharpChar` (`\u`, `\x`, `\U`, `CHAR_ESCAPES`) with C# regular strings.

**F5 (suggestion): a property with a non-public getter is counted as on the wire.**
`parse-contracts.ts:312` checks only that a `get` token exists. Input: base `public int X { get; set; }`, revision
`public int X { private get; set; }`. System.Text.Json no longer writes `X`, so this is a removal. Actual: `(no changes)`.
Fix: skip the property (or fail it, unless `[JsonInclude]` is present) when `get` is preceded by `private`,
`protected` or `internal` in the accessor list.

**F6 (suggestion): shape pairing turns unrelated messages into a rename.**
`compare-contracts.ts:253-260`. Input: base `Cancelled(Guid OrderId)`, revision `Shipped(Guid OrderId)`.
Actual: `message-renamed` breaking `N.Cancelled -> N.Shipped`. This hides `message-removed` (which says to drain the
queue) and `message-added`. One-property shapes such as `{orderid:Guid}` are common in MassTransit contracts.
Fix: pair by shape only when the shape has at least two properties, or keep the pairing but say "paired by identical
wire shape" in the message so that a reviewer can accept it knowingly.

**F7 (suggestion): the init detector also enables test projects.**
`init.ts:40-41`: `/Contract|Messages$/` matches `tests/Orders.Contracts.Tests/...`, so the starter config compares
public test classes as messages. Fix: skip segments that match `/(\.|^)Tests?$/` or `Test` before taking the folder.

**F8 (suggestion): duplicated helpers and plan drift.**
`message-contracts-layer.ts:27,145-174` copies `READ_CONCURRENCY` and `mapWithConcurrency` from
`persisted-enums-layer.ts:18,155`. Extract them into a shared module. `plan.md` Phase 2 lists `scan-queues.ts`, which
does not exist because queue scanning lives in the layer file. Update the plan before archiving.

## Checked and fine
- Tokenizer: holes with nested strings, chars, braces and newlines; `$@`/`@$`; raw `$$"""`; the persisted-enums suite
  passes. Interpolated token text is now raw instead of unescaped, which is harmless for enums (C# enum values are
  never strings) but feeds F1.
- Fail-closed paths: unbalanced brackets, `#if` in bodies or positional lists, an unreadable public member, a
  non-literal `[JsonPropertyName]` or `[MessageUrn]`, duplicate non-partial types, duplicate identities, and source or
  queue coverage. Each one sets `status: "failed"` and keeps the findings.
- Classification follows the plan and the plan review (C1 to C3, W2, W3, W5, S1). Qualified attribute names
  (`System.Text.Json.Serialization.JsonPropertyName`, `MassTransit.MessageUrn`) are recognised.

## Resolution (2026-10-07)
- F1, F2, F3, F5, F7: fixed, each with a regression test.
- F8: plan text corrected; the concurrency helper copy stays until a third layer needs it.
- F4, F6: kept and documented (see plan.md, "Impl review outcome").
