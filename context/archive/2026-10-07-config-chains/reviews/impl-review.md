# Implementation review: config-chains

Verdict: approved.

- `chains.ts` holds the check and the chain accept; `classify.ts` only exports `toEvidence`.
- Accept entries are routed by their `chain` field, so schema errors keep field paths (`accept.0.id`) instead of
  a bare union error.
- Messages carry source names and key identities only, never default values.
- Evidence comes from the revision declarations of the sources that have the key; a missing source has no line to
  point at.
