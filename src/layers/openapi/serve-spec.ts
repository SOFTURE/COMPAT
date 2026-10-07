import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RefTree } from "../../git/ref-tree.js";
import {
  type BackgroundProcess,
  findFreePort,
  withBackgroundProcess,
} from "../../process/background-process.js";
import { pollUrl } from "../../process/http-poll.js";
import { getTailLines } from "../../process/run-process.js";
import { err, ok, type Result } from "../../result.js";
import { PORT_PLACEHOLDER, type ServeSource } from "./config.js";
import { redactUrl } from "./safe-path.js";

export const DEFAULT_SERVE_TIMEOUT_SECONDS = 180;
const OUTPUT_TAIL_LINES = 20;
/** Stands in for `{port}` while a URL template is redacted; no real request uses it. */
const DISPLAY_PORT = "65535";

export type ServeSpecOptions = {
  source: ServeSource;
  tree: RefTree;
  /** The materialized tree of `tree`; the working directory of the app. */
  root: string;
  tempDir: string;
  apiName: string;
  env: NodeJS.ProcessEnv;
};

export type ServedSpec = { file: string; displayPath: string };

/** The URL template as the report shows it: redacted, with `{port}` kept so both sides read the same. */
export function getServeDisplayPath(url: string): string {
  return redactUrl(url.replaceAll(PORT_PLACEHOLDER, DISPLAY_PORT)).replace(
    `:${DISPLAY_PORT}`,
    `:${PORT_PLACEHOLDER}`,
  );
}

/**
 * Starts the app of a `serve` source on a free port inside the materialized ref, waits for the
 * `ready` URL (when set) and the spec URL, saves the spec and always stops the app.
 */
export async function resolveServeSpec(options: ServeSpecOptions): Promise<Result<ServedSpec>> {
  const { source, tree } = options;
  const label = `serve source at ${tree.side} (${tree.ref})`;
  const headers = interpolateHeaders(source.headers ?? {}, options.env);
  if (!headers.ok) return err(`${label}: ${headers.error}`);
  const port = await findFreePort();
  if (!port.ok) return err(`${label}: ${port.error}`);
  const withPort = (text: string) => text.replaceAll(PORT_PLACEHOLDER, String(port.value));
  const env: NodeJS.ProcessEnv = { ...options.env };
  for (const [name, value] of Object.entries(source.env ?? {})) env[name] = withPort(value);
  Object.assign(env, {
    COMPAT_SIDE: tree.side,
    COMPAT_REF: tree.ref,
    COMPAT_COMMIT: tree.commit,
    COMPAT_PORT: String(port.value),
  });
  const portHeaders = Object.fromEntries(
    Object.entries(headers.value).map(([name, value]) => [name, withPort(value)]),
  );
  const timeoutSeconds = source.timeoutSeconds ?? DEFAULT_SERVE_TIMEOUT_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1000;
  const displayPath = getServeDisplayPath(source.url);

  const served = await withBackgroundProcess(
    { command: withPort(source.run), cwd: options.root, env },
    async (app) => {
      const waits = [
        ...(source.ready ? [{ url: source.ready, accept: undefined }] : []),
        { url: source.url, accept: isOpenapiDocument },
      ];
      let body = "";
      for (const wait of waits) {
        const outcome = await pollUrl({
          url: withPort(wait.url),
          headers: portHeaders,
          deadline,
          accept: wait.accept,
          getStopReason: () => describeExit(app),
        });
        const shownUrl = getServeDisplayPath(wait.url);
        if (outcome.status === "stopped") {
          return err(
            `${outcome.reason} before ${shownUrl} answered (last: ${outcome.lastObservation})${outputTail(app)}`,
          );
        }
        if (outcome.status === "timed-out") {
          return err(
            `${shownUrl} not ready after ${timeoutSeconds} s (last: ${outcome.lastObservation})${outputTail(app)}`,
          );
        }
        body = outcome.body;
      }
      return ok(body);
    },
  );
  if (!served.ok) return err(`${label}: ${served.error}`);
  const file = join(options.tempDir, `${options.apiName}-${tree.side}.spec`);
  await writeFile(file, served.value, "utf8");
  return ok({ file, displayPath });
}

/** Replaces `${VAR}` in header values; a missing variable is an error that names it, never a value. */
export function interpolateHeaders(
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Result<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers)) {
    const missing: string[] = [];
    result[name] = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
      const value = env[variable];
      if (value === undefined) missing.push(variable);
      return value ?? "";
    });
    if (missing.length > 0) return err(`header "${name}" uses \${${missing[0]}}, which is not set`);
  }
  return ok(result);
}

/** JSON with a top-level `openapi` or `swagger` key, or YAML text with such a top-level key. */
export function isOpenapiDocument(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && ("openapi" in parsed || "swagger" in parsed);
  } catch {
    return /^["']?(openapi|swagger)["']?\s*:/m.test(body);
  }
}

function describeExit(app: BackgroundProcess): string | null {
  const exit = app.getExit();
  if (exit === null) return null;
  return exit.signal ? `app was stopped by ${exit.signal}` : `app exited ${exit.code ?? 1}`;
}

function outputTail(app: BackgroundProcess): string {
  const tail = getTailLines(app.getOutput(), OUTPUT_TAIL_LINES);
  return tail ? `; app output: ${tail}` : "; the app printed nothing";
}
