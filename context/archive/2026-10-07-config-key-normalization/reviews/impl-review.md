# Implementation review: config-key-normalization

Verdict: approved.

- Comparison units (per file at both refs) are unchanged; only the index key moved from spelling to identity.
- Messages still never carry default values; spellings are key names only.
- Notes count keys by identity, so `N key(s)` can drop when spellings merge; expected.
- S1 (suggestion, not done): evidence could carry the spelling per entry, which needs a core `Evidence` field.
