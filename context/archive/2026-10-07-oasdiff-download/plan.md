# Plan: oasdiff-download

Input: change.md, issue #13, `src/layers/openapi/oasdiff.ts`, `openapi-layer.ts`. Complexity: medium.

## Goal
When oasdiff is neither configured nor on PATH, the `openapi` layer uses the pinned v1.33.0 release from the cache,
or downloads and verifies it first; the report says where the binary came from.

**Out of scope:** other oasdiff versions chosen by the consumer; changing this repository's own CI (it keeps
`go install`, which also covers the real-oasdiff tests).

## Approach
**Chosen:** `oasdiff-download.ts` maps `process.platform`/`arch` to the release asset (`darwin_all`,
`linux_amd64`, `linux_arm64`, `windows_amd64`, `windows_arm64`), fetches it with the global `fetch`, compares its
SHA-256 with the value embedded in `PINNED_OASDIFF`, extracts the binary with a small built-in tar reader and moves
it into the cache with an atomic rename. `locateOasdiff` now reports its source; `probeOasdiff` is shared so the
cached binary is also proven with `--version`.
Rejected: shelling out to `tar` (one more external tool, differs on Windows); trusting the remote `checksums.txt`
(a compromised release would carry a matching one); a tar library dependency (the archive layout is two files).

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Download failure | layer `failed` | an incomplete check must never pass | issue |
| Unsupported platform | layer `skipped` with the install hint | nothing to download; same as before | plan |
| Opt-out | `--no-download` sets `SOFTURE_COMPAT_NO_DOWNLOAD=1` for the layers; config `download: false` | one switch for CLI and CI | issue |
| Cache root | `SOFTURE_COMPAT_CACHE_DIR`, else `XDG_CACHE_HOME`/`~/.cache` (`LOCALAPPDATA` on Windows) | issue default, platform-aware | issue |
| Cache trust | a file in the cache was written only after verification (temp file + rename) | no binary hash is published to re-check | plan |
| Proxy | documented `NODE_USE_ENV_PROXY=1` | Node's fetch ignores `HTTPS_PROXY` otherwise | plan |

## Phase 1: Downloader, layer, CLI, docs
1. `oasdiff-download.ts` with checksums from the v1.33.0 `checksums.txt`.
2. `oasdiff.ts`: `OasdiffSource`, `probeOasdiff`.
3. `openapi-layer.ts`: `findOasdiff` (locate → opt-out → provide → probe), source in the first note.
4. `config.ts`: `oasdiff.download`; `main.ts`: `--no-download`.
5. README: install, options, config key, CI example without `actions/setup-go`.

**Tests:** unit tests for asset mapping, cache dir, tar extraction, download/verify/cache, tampered archive, HTTP and
network errors; layer tests for tampered (`failed`), cached run with no network, opt-outs (`skipped`); e2e
`--no-download`. A manual run downloaded the real v1.33.0 linux_amd64 archive, verified it and reused the cache.

## Risks and rollback
- A runner without internet now fails the layer instead of skipping it: `--no-download` restores the old outcome.
- Rollback: revert the commit; the cache directory can be deleted at any time.

## Progress
### Phase 1: Downloader, layer, CLI, docs
- [x] Downloader with embedded checksums
- [x] Layer, CLI flag and config key
- [x] Tests
- [x] README
