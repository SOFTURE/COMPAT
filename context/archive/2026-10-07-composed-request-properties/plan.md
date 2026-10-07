# Plan: composed-request-properties

Input: change.md, issue #70. Complexity: small (property path, type reader, README).

## Goal
Acceptance (issue #70):
1. a body `allOf: [{$ref: Base}, {properties: {daysOfWeek}}]` with a client declaring `daysOfWeek: DayOfWeek[]`
   reclassifies `request-property-became-not-nullable` to `safe`;
2. the same client with `daysOfWeek?: DayOfWeek[]` keeps the class and names the refs.

**Out of scope:** proving properties under `oneOf`/`anyOf`; generic intersections (`A<T> & B`).

## Approach
| Decision | Choice | Why |
| --- | --- | --- |
| `allOf[...]` segments | dropped before resolving the path against client types | a generated client flattens allOf into one interface or an intersection, so the property is a direct member |
| `oneOf[...]` / `anyOf[...]` | the property is never proven always sent | no single client type guarantees it |
| Intersections | `type X = A & B & { ... }` gets the merged members of its parts, resolved after all types are read | how generators write allOf as a type alias |
| Not-nullable rule | also needs the property declared without `?` | an omitted property can reach the server as null; the acceptance keeps `daysOfWeek?:` breaking |

## Progress
- [x] Phase 1: failing tests (allOf path, intersection reader, optional property)
- [x] Phase 2: path segments in `refine.ts`, intersections in `read-typescript-client.ts`, README
- [x] Gates: typecheck, lint, test
