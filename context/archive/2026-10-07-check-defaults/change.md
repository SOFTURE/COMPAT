# Change: check-defaults

Source: issue #42. Area: config file, `check` and `init` commands, report header, GitHub Action.

`check` needs `--base` and `--revision` on every run, so each repository wraps it in an npm script that pins the
same two resolvers. The refs to compare are part of the repository's setup, like the layers, so they belong in
`compat.config.json`: an optional top-level `check` object with `base`, `revision` and `failOn`, overridden by the
command-line flags. `init` writes a guess, and the report header says where each ref came from.

**Out of scope:** config defaults for other flags (`--require`, `--allow-incomplete`, `--format`), a default
`revision` of `HEAD` when nothing sets it (the issue keeps exit code 2).
