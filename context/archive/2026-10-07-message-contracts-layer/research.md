# Research: message-contracts-layer

## Question
How should a source-level layer tell whether the message contracts and queues of two refs stay compatible for
messages in flight during a deploy and a rollback?

## Findings
- **Message identity.** MassTransit names a message type by its URN, `urn:message:<Namespace>:<TypeName>`, with
  nested types joined by `+` and generic arguments spelled out. Renaming a type or moving it to another namespace
  changes the URN, so messages published by the other build are no longer delivered to its consumers. Identity is
  therefore the full name (namespace, enclosing types, name, generic arity).
- **Serialization.** MassTransit 8 uses System.Text.Json with camelCase names, case-insensitive property matching
  and `JsonStringEnumConverter`. Consequences: a property rename that changes only letter case is not a change;
  `[JsonPropertyName("x")]` sets the wire name; `[JsonIgnore]` removes the property from the wire; enums travel as
  their names (string storage rules of persisted-enums apply; `int` is configurable).
- **Which members travel.** Public instance properties with accessors (`get; set;`, `get; init;`, `required`),
  and the positional parameters of a `record` / `record struct` primary constructor. Fields, static members, constants,
  expression-bodied computed properties (`=> ...`), methods, events, indexers and the primary constructor parameters
  of a non-record class do not carry message data.
- **Missing properties.** A consumer that reads a message without a property gets `default(T)` (or a failure for a
  `required` member, .NET 7+). A new property is harmless when it is nullable (`T?`) or has an initializer; otherwise
  the new consumer reads messages of the old producer with a wrong or missing value: `rollback-risk` (issue #16).
- **Existing pieces.** `src/layers/persisted-enums/tokenize.ts` handles every C# literal form (raw, verbatim,
  interpolated strings, chars, directives); `parse-enums.ts` and `compare-enums.ts` parse and compare enums;
  `src/layers/config/comments.ts` strips comments for regex sources; `src/layers/config/config.ts` shows the regex
  source shape (named group, flags, comments).

## Open questions resolved by default
- Types counted as contracts: every public, non-static class, record, struct and interface in the sources (nested
  types included). Contract assemblies hold messages and the types they embed; both break the same way.
- Inheritance: properties of a base type declared in the same source are flattened into the derived type. A base
  outside the sources is not followed (noted in the README).
- Generic types are keyed by name and arity (`Envelope`1`).
