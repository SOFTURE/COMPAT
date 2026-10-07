# Plan review: config-key-normalization

Verdict: approved.

- W1 (addressed): normalizing by default changes finding subjects for existing users. Accept entries are
  normalized too, so existing entries keep matching; `keyMatching: "exact"` restores the old behaviour.
- W2 (addressed): an `enclosing` pattern without a template would be silently unused; the schema rejects it.
- S1 (kept): `enclosing` is the nearest preceding match, not brace-aware nesting. Documented in the README; a nested
  class would lend its name to later members of the outer class.
