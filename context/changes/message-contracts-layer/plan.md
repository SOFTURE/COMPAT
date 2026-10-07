# Plan: message-contracts-layer

Input: change.md, research.md, issue #16. Complexity: medium (one new layer folder with a C# structural parser,
plus the registry line, the init detector and the README section the existing tests require for every layer).

## Goal
With `layers["message-contracts"]` in `compat.config.json`, `softure-compat check` parses the C# contract types of
both refs and the queue names of configured regex sources, and reports:

| Finding | Class |
| --- | --- |
| `message-added`, `queue-added` | `safe` |
| `message-property-added`, nullable (`T?`) or with an initializer | `safe` |
| `message-property-added`, otherwise (incl. `required`) | `rollback-risk` |
| `message-removed`, `queue-removed` | `needs-action` (drain the queue first) |
| `message-renamed` (same shape or same simple name, different full name) | `breaking` |
| `message-property-removed`, `message-property-type-changed` | `breaking` |
| enums declared in the sources | persisted-enums ids and rules, `string` storage by default |

PETSEO F8 is reproduced end to end: three messages and one queue added, all `safe`; a namespace move is
`message-renamed`, `breaking`.

**Out of scope:** ApiCompat on built assemblies (backlog); base types outside the sources; message topology beyond
queue names (exchanges, routing keys); languages other than C#.

## Approach
**Chosen:** tokenize each source file with the persisted-enums tokenizer, then a small structural parser walks
namespaces and type bodies and returns contract types `{ fullName, simpleName, kind, line, properties[] }` plus every
declaration it saw (for the safety net) and the types it could not read. Enums are parsed with `parseEnums` and
attached to their full name by line. A pure comparison turns the two indexes into changes; the layer turns changes
into findings, applies `accept`, and fails closed on anything it could not read.
Rejected: Roslyn or ApiCompat (needs .NET and a build; contrary to the other layers); regex-only scanning (cannot
tell properties from fields and methods, and loses whole files after unusual literals; lesson CMP-4).

**Key decisions:**
| Decision | Choice | Why |
| --- | --- | --- |
| Config | `{ sources: [{ name, language: "csharp", files, enumStorage? }] (min 1, unique names), queues?: [{ kind: "regex", name, files, pattern, flags?, comments? }], accept?: [{ id, subject, reason }] }`, all strict | the shape proposed in issue #16, with names so scopes and accepts can tell sources apart |
| Identity | full name `Namespace.Outer+Inner`, generic arity as `` `N ``; compared within one source | MassTransit URN |
| Contract types | public, non-static `class`, `record`, `record class`, `record struct`, `struct`, `interface`; nested public types too | research |
| Properties | public instance properties with an accessor block (interface members are public by default), record positional parameters; skipped: fields, static, const, `=>` properties, methods, ctors, events, indexers, operators, explicit interface members, `[JsonIgnore]` | research |
| Wire name | `[JsonPropertyName("x")]` string, else the property name; compared case-insensitively | System.Text.Json in MassTransit |
| Type text | tokens joined without spaces (`, ` after commas), `global::` dropped, `Nullable<T>` as `T?`, `System.X` aliases (`String`, `Int32`, ...) as keywords | trivia must not read as a type change |
| Inheritance | base types resolved to a type of the same source (by simple name, then by full name) are flattened, derived members win | `record Derived : Base` keeps Base's wire properties |
| Partial types | declarations with `partial` and the same full name merge; any other duplicate full name is unreadable | one type per URN |
| Rename pairing | a removed and an added type of one source pair when their wire shapes are equal and non-empty, or when their simple names are equal and unique on both sides | issue #16: same shape, different full name |
| Paired type | one `message-renamed` finding plus its property changes | the rename is the cause; property changes still matter for the new consumer |
| Enums | every enum declared in the sources, compared with `compareEnums` under the source's `enumStorage` (default `string`); ids reused from persisted-enums | issue #16: persisted-enums rules |
| Queues | regex sources with named group `queue` (else group 1); `comments` default `slash`; set of names per source; added `safe`, removed `needs-action` | issue #16 |
| Fail closed | layer `failed` (findings kept) when: a source or queue source matches no file at either ref; it matches files at the base but none in the revision; a source finds no type and a queue source no queue at either ref; a type is unreadable (directive in its body, unclosed body, unrecognised public member); a declaration line the parser did not see (safety net) | lesson compat-scanner-lesson |
| Accept | `{ id, subject, reason }`, exact match on the finding subject; usage notes as in persisted-enums | consistency |
| Evidence | `path:line` of the type, property or queue at the ref(s) involved | consistency |
| init | enabled when C# files sit under a folder whose name contains `Contract` or ends with `Messages`; else disabled example | init requires a detector per layer |

## Plan review outcome
`reviews/plan-review.md` (approve with changes). Taken: C1 `[MessageUrn]` is the identity when present and an
`[EntityName]` change is `message-entity-name-changed`, `breaking`; C2 `= null!`, `= default`, `= default!`,
`= default(T)` are not defaults; C3 an added `required` or `[JsonRequired]` property is `breaking`; C5 renames pair
across sources (one index for all sources, scope = the source); W2 base-list changes are `message-base-added`
(`safe`) and `message-base-removed` (`breaking`); W3 a change of `?` only is `message-property-nullability-changed`,
`rollback-risk`; W5 a `[JsonPropertyName]` or `[MessageUrn]` argument that is not a string literal fails the type;
S1 shape pairing needs a unique, non-empty shape. Kept: C4 (`[JsonIgnore(Condition = ...)]` other than `Always`
already keeps the property), W1 (issue #16 names `rollback-risk` for a new non-nullable property), W4 (setter
visibility), `[JsonConverter]`, collection equivalence and a MassTransit package signal for init (README lists what
the layer does not see).

Implementation note: the persisted-enums tokenizer lost the rest of a line after `$"{(a ? "x" : "y")}"` (a string
inside an interpolation hole); `readInterpolated` now reads holes with nested strings, chars and braces, with a
regression test in `parse-enums.test.ts`.

## Phases
1. Parser: `parse-contracts.ts` + tests (every literal form, records, classes, interfaces, nested, generic, partial,
   inheritance, attributes, directives, safety net).
2. Comparison and layer: `config.ts`, `compare-contracts.ts`, `scan-queues.ts`, `message-contracts-layer.ts`, registry
   line, init detector, README section, unit tests and the PETSEO F8 e2e test.
3. Gates and review: typecheck, lint, test, build + pack test; impl review; archive.

## Progress
- [x] Phase 1: parser
- [x] Phase 2: comparison, layer, registry, init, README
- [ ] Phase 3: gates, impl review, archive
