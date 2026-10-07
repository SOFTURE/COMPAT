# Plan review: broker-only-contracts

- Scope matches issue #45: selection of folders in `init` and the nullability text; no class changes.
- Reading every `.cs` file at HEAD once is acceptable for `init` (a one-off command); the folder files are read
  only for folders whose name does not already decide.
- Unknown external types keep a message that states both outcomes instead of guessing a kind. Accepted.
