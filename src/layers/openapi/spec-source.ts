import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RefTree } from "../../git/ref-tree.js";
import { err, ok, type Result } from "../../result.js";
import type { SpecSource } from "./config.js";
import { redactUrl, resolveInsideTree } from "./safe-path.js";
import { runTreeCommand } from "./tree-command.js";

const URL_TIMEOUT_MS = 30_000;

export type ResolvedSpec =
  | {
      status: "found";
      /** Absolute path to give oasdiff. */
      file: string;
      /** Materialized tree the spec lives in; evidence paths are made relative to it. `null` for URLs. */
      root: string | null;
      /** How the spec is named in the report. */
      displayPath: string;
    }
  | { status: "absent"; displayPath: string };

export type ResolveSpecOptions = {
  source: SpecSource;
  tree: RefTree;
  tempDir: string;
  apiName: string;
  env: NodeJS.ProcessEnv;
};

export async function resolveSpec(options: ResolveSpecOptions): Promise<Result<ResolvedSpec>> {
  const { source } = options;
  switch (source.kind) {
    case "file":
      return resolveFileSpec(options.tree, source.path);
    case "command":
      return resolveCommandSpec(options, source);
    case "url":
      return resolveUrlSpec(options, source[options.tree.side]);
  }
}

async function resolveFileSpec(tree: RefTree, path: string): Promise<Result<ResolvedSpec>> {
  const root = await tree.materialize();
  if (!root.ok) return root;
  const resolved = await resolveInsideTree(root.value, path);
  if (!resolved.ok) return resolved;
  if (resolved.value.status === "absent") return ok({ status: "absent", displayPath: path });
  return ok({ status: "found", file: resolved.value.path, root: root.value, displayPath: path });
}

async function resolveCommandSpec(
  options: ResolveSpecOptions,
  source: Extract<SpecSource, { kind: "command" }>,
): Promise<Result<ResolvedSpec>> {
  const { tree } = options;
  const root = await tree.materialize();
  if (!root.ok) return root;
  // A committed copy of the output must not pass for a fresh export when the command writes elsewhere.
  const staleOutput = await resolveInsideTree(root.value, source.output);
  if (!staleOutput.ok) return staleOutput;
  if (staleOutput.value.status === "found") await rm(staleOutput.value.path, { force: true });
  const ran = await runTreeCommand({
    run: source.run,
    tree,
    root: root.value,
    timeoutSeconds: source.timeoutSeconds,
    env: options.env,
    label: "export command",
  });
  if (!ran.ok) return ran;
  const output = await resolveInsideTree(root.value, source.output);
  if (!output.ok) return output;
  if (output.value.status === "absent") {
    return err(`export command at ${tree.side} (${tree.ref}) succeeded but did not write ${source.output}`);
  }
  return ok({ status: "found", file: output.value.path, root: root.value, displayPath: source.output });
}

async function resolveUrlSpec(options: ResolveSpecOptions, url: string): Promise<Result<ResolvedSpec>> {
  const displayPath = redactUrl(url);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(URL_TIMEOUT_MS) });
  } catch (error) {
    const cause = (error as Error).name === "TimeoutError" ? "timed out" : "request failed";
    return err(`cannot fetch ${displayPath}: ${cause}`);
  }
  if (!response.ok) return err(`cannot fetch ${displayPath}: HTTP ${response.status}`);
  const file = join(options.tempDir, `${options.apiName}-${options.tree.side}.spec`);
  await writeFile(file, await response.text(), "utf8");
  return ok({ status: "found", file, root: null, displayPath });
}
