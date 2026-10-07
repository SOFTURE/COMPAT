# Plan review: init-file-selection

Verdict: approved.

- Scope matches issue #46 and keeps the new logic out of the functions #44 and #45 change.
- Explicit `files` only when something is left out keeps existing `init` output and tests unchanged.
- Every written regex source is verified to find a key at HEAD, so `init` never writes a source that fails `check`.
