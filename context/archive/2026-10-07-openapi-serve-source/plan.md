# Plan: openapi-serve-source

Input: change.md, issue #11, `src/layers/openapi/*`, `src/process/run-process.ts`. Complexity: medium.

## Goal
`{ "kind": "serve", "run", "url", "ready?", "env?", "headers?", "timeoutSeconds?" }` resolves a spec by running the
app inside the materialised ref, polling the URL until it returns 2xx with an OpenAPI document, then stopping the
whole process group.

**Out of scope:** reusing one running app for several APIs (each API with a `serve` source starts its own app);
HTTPS with self-signed certificates; Windows process-tree killing beyond what `runProcess` already does.

## Approach
**Starting point:** `runProcess` only runs a process to completion; process groups are tracked inside it so the CLI
can kill them on SIGINT.

**Chosen:**
- `src/process/process-groups.ts`: the live process group registry and `killGroup`, shared by `runProcess` and the
  new helper; `killAllProcessGroups` keeps working for both.
- `src/process/background-process.ts`: `startBackgroundProcess` (shell, own process group, combined output kept as a
  bounded tail, `exit` state) with `stop()` = SIGTERM to the group, a grace period, then SIGKILL to the group;
  `withBackgroundProcess(options, use)` guarantees `stop()` in `finally`. `findFreePort()` asks the OS for a port and
  never hands out the same port twice in one CLI run, so parallel sides cannot clash.
- `src/process/http-poll.ts`: `pollUrl` fetches a URL until an `accept` predicate passes, the deadline passes, or a
  `shouldStop` check fires; it returns the last observation (`HTTP 401`, `connection refused`, `timed out`).
- `spec-source.ts`: `resolveServeSpec` substitutes the port, interpolates headers, starts the app, waits for `ready`
  (when set) and the spec, writes it to the temp dir; failures name the side, ref, URL template, last observation
  and app output tail.
- `init`: no committed spec but a `*.csproj` referencing `FastEndpoints.Swagger`, `NSwag.AspNetCore` or
  `Swashbuckle.AspNetCore` proposes a disabled `serve` source per such project.

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Timeouts | one `timeoutSeconds` (default 180, max 7200) for start-up until the spec is fetched | the app is stopped right after the fetch, so a second cap adds nothing | plan |
| Spec validity | 2xx and the body parses as JSON with `openapi`/`swagger`, or YAML text with a top-level `openapi:`/`swagger:` key | an app may answer 200 with an HTML error page while starting | plan |
| Display path | the URL template, redacted, with `{port}` kept | the same on both sides, no port noise in the report | plan |
| Missing `${VAR}` in a header | layer error naming the variable, never its value | silent empty auth headers produce a misleading 401 | plan |
| Stop | SIGTERM, 3 s grace, SIGKILL to the group | lets the app shut down cleanly, still never leaves orphans | issue #11 |
| Environment | `COMPAT_SIDE`, `COMPAT_REF`, `COMPAT_COMMIT`, `COMPAT_PORT` plus `env` | same as `command` sources | issue #12 |

## Phase 1: Process helpers
1. `process-groups.ts`, `runProcess` on it.
2. `background-process.ts`: start, stop, `withBackgroundProcess`, `findFreePort`.
3. `http-poll.ts`.

**Tests:** stop kills a child ignoring SIGTERM and its grandchild; output tail; exit detection; unique free ports;
poll observations (HTTP status, connection refused, deadline).

## Phase 2: Serve source, init, docs
1. `config.ts`: `serve` schema.
2. `spec-source.ts`: `resolveServeSpec`.
3. `init.ts`: csproj detection.
4. README.

**Tests:** a Node test app serving its spec only at runtime, base and revision in parallel through the layer; `401`
error contains `HTTP 401` and no header value; app exiting early; timeout with a SIGTERM-ignoring app leaves no
process; config schema; init proposal.

## Risks and rollback
- A port taken between `findFreePort` and the app binding: the app fails to start and the error shows its output.
- Rollback: revert the commit; no other source kind changes behaviour.

## Progress
### Phase 1: Process helpers
- [x] Process group registry
- [x] Background process helper and free ports
- [x] URL polling
### Phase 2: Serve source, init, docs
- [x] Config schema
- [x] Serve spec source
- [x] init proposal
- [x] README
- [x] Tests (typecheck, lint, full suite green)
