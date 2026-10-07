# Plan review: message-contracts-layer

## Verdict
**Approve with changes.** The approach (tokenizer reuse, structural parser, pure compare, fail closed) is right.
C1-C5 are fail-open holes that would let a breaking deploy pass `--fail-on breaking`. Fix them in the plan first.

## Critical
- **C1. `[MessageUrn]` / `[EntityName]` ignored.** Problem: MassTransit takes the URN from `[MessageUrn("...")]` when
  it is present, and `[EntityName]` sets the exchange/topic. Why: changing the attribute on an unchanged full name is a
  real rename that the plan misses. A namespace move under a fixed `MessageUrn` is a false `breaking`. Fix: identity =
  attribute value when present, else the full name. Report an `[EntityName]` change as `message-renamed`. An attribute
  argument that is not a string literal makes the type unreadable.
- **C2. `= null!` / `= default!` / `= default` count as initializers.** Problem: `public string Name { get; set; } = null!;`
  is the normal NRT idiom, and the plan would call the new property `safe`. Why: the consumer then reads null into a
  non-nullable property from in-flight old messages. Fix: these initializers count as no initializer. Add tests.
- **C3. `required` / `[JsonRequired]` classed `rollback-risk`.** Problem: STJ (.NET 7+) throws when a required member
  is missing. Why: every old message in flight faults to `_error` on the new consumer as soon as the release is
  deployed. That is `breaking` by the README definition, not a rollback problem. Fix: an added `required` or
  `[JsonRequired]` property (and a change from optional to required) is `breaking`.
- **C4. `[JsonIgnore(Condition = ...)]` read as removal.** Problem: only bare `[JsonIgnore]` and `Condition = Always`
  take a property off the wire. `WhenWritingNull`, `WhenWritingDefault` and `Never` keep it. Why: going from
  `WhenWritingNull` to bare `[JsonIgnore]` reads as "ignored on both sides" and the removal is never reported.
  Fix: parse `Condition`. Any other argument form is unreadable.
- **C5. Cross-source moves are not paired.** Problem: rename pairing and identity work within one source, so moving a
  message to another contracts project (another source) reads as `message-removed` (`needs-action`) plus
  `message-added` (`safe`). Why: the URN changed, and with the default gate the result passes. Fix: pair
  removed/added types across all sources of the layer (scope = revision source), or treat a removed type whose
  simple name reappears in any source as `message-renamed`.

## Warnings
- **W1. Wrong class for a non-nullable added property.** Problem: during a rollback, new messages reach the old
  consumer and STJ just skips the unknown member, so nothing breaks. The real risk comes during the deploy: old
  in-flight messages give the new consumer `default(T)`. Why: `rollback-risk` contradicts README line 91 and sends
  users looking at the wrong window. Fix: use `needs-action` (drain the queue or handle the default) with an
  accurate message, or keep the class issue #16 asked for but correct the message text. Record the decision in the plan.
- **W2. Base-type / interface list changes are not compared.** Problem: MassTransit publishes a message under every
  base type and interface URN, and consumers bound to a base receive derived messages. Why: dropping
  `: IPetEvent` silently stops delivery to those consumers. Fix: `message-base-removed` = `breaking`,
  `message-base-added` = `safe`, compared on resolved full names.
- **W3. Nullability-only type changes.** Problem: comparing type text turns `string` -> `string?` (a reference type,
  no wire change) into a `breaking` false positive. `int` -> `int?` is a rollback risk (null reaches the old
  consumer), and `int?` -> `int` is breaking (an old message holding null throws). Fix: drop `?` for known reference
  types (`string`, arrays, collections, class/record/interface types of the sources). Classify value-type
  nullability as above. Leave everything else as `type-changed`.
- **W4. Non-settable properties.** Problem: STJ does not deserialize `{ get; }` (no constructor parameter) or
  `{ get; private set; }` without `[JsonInclude]`, so the consumer reads the default. Why: a change from
  `{ get; set; }` to `{ get; private set; }` is a silent break. Fix: record whether a property is readable on
  deserialize. A change from readable to not readable is `breaking`. Record positional parameters and `init` count as readable.
- **W5. Generic depth when splitting.** Problem: the tokenizer emits `>>` as one token, and splitting record
  parameters by comma must track `<`/`>`/`>>` (unlike `splitMembers`). Why: `(Dictionary<string, List<int>> Map, ...)`
  would otherwise split into bogus parameters, or swallow one silently. Fix: track depth over `<`, `>`, `>>` and fail
  on negative or unbalanced depth. Add a test.
- **W6. Attribute forms.** Problem: `[property: JsonPropertyName("x")]` on positional parameters, named arguments,
  and `nameof(...)` or a constant as the argument. Why: falling back to the C# name when the argument cannot be read
  is fail-open. Fix: support the `property:` target. A non-literal argument makes the type unreadable. Duplicate wire
  names after case folding (including a positional parameter redeclared as a body property) are unreadable, unless
  it is the record-redeclare pattern, which merges.
- **W7. `[JsonConverter]` / `[JsonNumberHandling]` on a property or type.** Problem: these change the wire format
  without changing the type text. Fix: treat a change in these attributes as `message-property-type-changed`.
- **W8. Base resolution "simple name, then full name" is ambiguous.** Problem: two `Base` types in different
  namespaces resolve arbitrarily. Fix: resolve the qualified name first, then the simple name only when it is unique
  in the source. Otherwise the type is unreadable. A base that is not found is not silent: put a note in `notes`.
- **W9. Safety net is undefined.** Problem: "a declaration line the parser did not see" has no algorithm. Fix: on the
  token stream, every `class|record|struct|interface|enum` keyword followed by an identifier (not after `.`, not
  `where T : class`, not `new()`/`struct` constraints) must map to a parsed or unreadable declaration. Say this in the plan.
- **W10. Accept cannot tell sources apart.** Problem: the plan gives sources names "so accepts can tell them apart",
  but `accept` is `{ id, subject, reason }`. Fix: add `scope` (the source or queue-source name) as a required key,
  or put the scope into the subject. Do the same for queue findings.

## Suggestions
- **S1. Shape-based rename pairing.** Commands such as `{ Id: Guid }` share a shape, so deleting one and adding
  another reads as a rename (`breaking` instead of `needs-action`). Pair by shape only when the match is unique on
  both sides, or cut shape pairing and keep the simple-name pairing (issue #16 only needs the namespace move).
- **S2. Equivalent collection types.** `List<T>`, `IReadOnlyList<T>`, `T[]` and `IEnumerable<T>` are the same JSON
  array. Normalizing them avoids noise. Optional; the `breaking` false positive can be accepted.
- **S3. Qualification noise.** `Foo` vs `Contracts.Foo` in property types, or a `using` alias, reads as a type change.
  Strip a namespace prefix when the remainder resolves to a source type.
- **S4. Directives.** Fail the file on `#if` anywhere in a file that declares a contract (not only inside a body), so
  a conditional base list or a type header cannot slip through.
- **S5. init detector.** "Folder contains `Contract`" also matches API/DTO projects. Add a `MassTransit`
  `PackageReference` in any `.csproj` as the enabling signal and use the folder only to fill `files`.
- **S6. README limits.** List what the layer does not see: queues named by `EndpointNameFormatter` from consumer
  names, queue names held in constants (a literal-only regex misses them), Newtonsoft-configured buses, internal
  message types, and enums double-reported when persisted-enums covers the same files.
