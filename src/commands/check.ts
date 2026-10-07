import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_CONFIG_FILE, loadConfig } from "../config/config.js";
import { openRefTree, type RefTree, resolveRepoRoot } from "../git/ref-tree.js";
import type { Layer } from "../layers/layer.js";
import { LAYERS } from "../layers/registry.js";
import { applyRevisions, splitOutput } from "../layers/revisions.js";
import type { LayerResult, Side } from "../model/finding.js";
import { evaluateGate, type FailOn } from "../model/gate.js";
import { killAllProcessGroups } from "../process/run-process.js";
import { renderJson } from "../report/json.js";
import { renderMarkdown } from "../report/markdown.js";
import type { RefInfo, RefSource } from "../report/report.js";
import type { FetchFn } from "../resolve/github.js";
import { parseRefSpec } from "../resolve/ref-spec.js";
import { resolveRefSpec } from "../resolve/resolve-ref.js";
import { err, ok, type Result } from "../result.js";

export const REPORT_FORMATS = ["md", "json"] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export type CheckOptions = {
  /** `--base`; falls back to `check.base` in the config. */
  base?: string;
  /** `--revision`; falls back to `check.revision` in the config. */
  revision?: string;
  repoDir?: string;
  configPath?: string;
  format: ReportFormat;
  outputPath?: string;
  /** `--fail-on`; falls back to `check.failOn` in the config, then `breaking`. */
  failOn?: FailOn;
  allowIncomplete: boolean;
  /** Layers that must run; a disabled, unconfigured, skipped or failed one fails the gate. */
  required?: string[];
};

export type CheckIo = {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Installs SIGINT and SIGTERM handlers for the run; only the real CLI sets it. */
  handleSignals?: boolean;
  /** Layers to use instead of the registry; tests inject stubs here. */
  layers?: Layer[];
  /** `fetch` for the GitHub resolvers; tests inject a mock here. */
  fetch?: FetchFn;
};

export const EXIT_CANNOT_RUN = 2;

const DEFAULT_FAIL_ON: FailOn = "breaking";

/** A ref to compare and where it was set. */
type RefChoice = { value: string; source: RefSource };

/** The flag wins over the config; neither is an error naming both. */
function chooseRef(
  side: Side,
  flag: string | undefined,
  configured: string | undefined,
  configPath: string,
): Result<RefChoice> {
  if (flag !== undefined) return ok({ value: flag, source: "flag" });
  if (configured !== undefined) return ok({ value: configured, source: "config" });
  return err(`no ${side} ref: pass --${side} or set check.${side} in ${configPath}`);
}

export async function runCheck(options: CheckOptions, io: CheckIo): Promise<number> {
  const repoDir = resolve(io.cwd, options.repoDir ?? ".");
  const configPath = resolvePath(repoDir, io.cwd, options.configPath);
  const layers = io.layers ?? LAYERS;
  const required = options.required ?? [];
  const unknown = required.filter((name) => !layers.some((layer) => layer.name === name));
  if (unknown.length > 0) {
    io.stderr(
      `softure-compat: --require names unknown layer(s) ${unknown.join(", ")}; known layers: ${layers.map((l) => l.name).join(", ") || "none"}\n`,
    );
    return EXIT_CANNOT_RUN;
  }

  const config = await loadConfig(configPath, layers);
  if (!config.ok) {
    io.stderr(`softure-compat: ${config.error}\n`);
    return EXIT_CANNOT_RUN;
  }
  if (config.value.layers.length === 0) {
    io.stderr(
      `softure-compat: no layer is enabled in ${configPath}; known layers: ${layers.map((l) => l.name).join(", ") || "none"}\n`,
    );
    return EXIT_CANNOT_RUN;
  }

  const { check: defaults } = config.value;
  const baseRef = chooseRef("base", options.base, defaults.base, configPath);
  if (!baseRef.ok) {
    io.stderr(`softure-compat: ${baseRef.error}\n`);
    return EXIT_CANNOT_RUN;
  }
  const revisionRef = chooseRef("revision", options.revision, defaults.revision, configPath);
  if (!revisionRef.ok) {
    io.stderr(`softure-compat: ${revisionRef.error}\n`);
    return EXIT_CANNOT_RUN;
  }
  const failOn = options.failOn ?? defaults.failOn ?? DEFAULT_FAIL_ON;

  const repoRoot = await resolveRepoRoot(repoDir);
  if (!repoRoot.ok) {
    io.stderr(`softure-compat: ${repoRoot.error}\n`);
    return EXIT_CANNOT_RUN;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "softure-compat-"));
  const stopOnSignal = installTerminationHandlers(tempRoot, io);
  try {
    const base = await openSide({
      choice: baseRef.value,
      side: "base",
      repoDir: repoRoot.value,
      tempRoot,
      io,
    });
    if (!base.ok) {
      io.stderr(`softure-compat: ${base.error}\n`);
      return EXIT_CANNOT_RUN;
    }
    const revision = await openSide({
      choice: revisionRef.value,
      side: "revision",
      repoDir: repoRoot.value,
      tempRoot,
      io,
    });
    if (!revision.ok) {
      io.stderr(`softure-compat: ${revision.error}\n`);
      return EXIT_CANNOT_RUN;
    }

    let results: LayerResult[] = [];
    for (const { layer, config: layerConfig } of config.value.layers) {
      const tempDir = join(tempRoot, `layer-${layer.name}`);
      await mkdir(tempDir, { recursive: true });
      try {
        const { result, revisions } = splitOutput(
          await layer.run({
            config: layerConfig,
            base: base.value.tree,
            revision: revision.value.tree,
            repoDir: repoRoot.value,
            tempDir,
            env: io.env,
            fetch: io.fetch,
            log: (message) => io.stderr(`[${layer.name}] ${message}\n`),
            results: [...results],
          }),
        );
        const revised = applyRevisions(results, revisions);
        if (revised.ok) {
          results = revised.value;
          results.push(result);
        } else {
          results.push({
            layer: layer.name,
            status: "failed",
            error: `invalid refinement: ${revised.error}`,
            findings: [],
            notes: result.status === "skipped" ? [] : result.notes,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          layer: layer.name,
          status: "failed",
          error: `unexpected error: ${message}`,
          findings: [],
          notes: [],
        });
      }
    }

    const { inactive } = config.value;
    const gate = evaluateGate(
      results,
      { failOn, allowIncomplete: options.allowIncomplete, required },
      inactive,
    );
    const report = {
      base: base.value.info,
      revision: revision.value.info,
      failOn,
      allowIncomplete: options.allowIncomplete,
      required,
      gate,
      layers: results,
      inactive,
    };
    const rendered = options.format === "json" ? renderJson(report) : renderMarkdown(report);
    if (options.outputPath === undefined) {
      io.stdout(rendered);
    } else {
      const outputPath = resolve(io.cwd, options.outputPath);
      try {
        await writeFile(outputPath, rendered, "utf8");
      } catch (error) {
        io.stderr(
          `softure-compat: cannot write the report to ${outputPath} (${(error as NodeJS.ErrnoException).code})\n`,
        );
        return EXIT_CANNOT_RUN;
      }
      io.stderr(`softure-compat: report written to ${outputPath}\n`);
    }
    io.stderr(`softure-compat: gate ${gate.passed ? "passed" : "failed"}\n`);
    return gate.exitCode;
  } finally {
    stopOnSignal();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

type OpenSideOptions = { choice: RefChoice; side: Side; repoDir: string; tempRoot: string; io: CheckIo };

/** Resolves a base or revision value and opens its tree; a resolved commit missing locally asks for a fetch. */
async function openSide(options: OpenSideOptions): Promise<Result<{ tree: RefTree; info: RefInfo }>> {
  const { choice, side, repoDir, tempRoot, io } = options;
  const resolved = await resolveRefSpec(parseRefSpec(choice.value), {
    repoDir,
    env: io.env,
    fetch: io.fetch,
  });
  if (!resolved.ok) return resolved;
  const { ref, commit, resolver } = resolved.value;
  const tree = await openRefTree({ repoDir, ref: commit ?? ref, label: ref, side, tempRoot });
  if (!tree.ok) {
    if (resolver === undefined) return tree;
    return err(
      `${resolver} resolved to ${ref} (${commit ?? ref}), which is not in the local clone; fetch it (actions/checkout with fetch-depth: 0)`,
    );
  }
  const info: RefInfo = { ref, commit: tree.value.commit, source: choice.source };
  if (resolver !== undefined) info.resolver = resolver;
  return ok({ tree: tree.value, info });
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Child processes run in their own process groups, so an interrupt does not reach them. On
 * SIGINT or SIGTERM, stop them, remove the temp dir and exit. Returns the uninstaller.
 */
function installTerminationHandlers(tempRoot: string, io: CheckIo): () => void {
  if (io.handleSignals !== true) return () => {};
  const handlers = Object.entries(SIGNAL_EXIT_CODES).map(([signal, exitCode]) => {
    const handler = () => {
      killAllProcessGroups();
      rmSync(tempRoot, { recursive: true, force: true });
      io.stderr(`softure-compat: interrupted by ${signal}\n`);
      process.exit(exitCode);
    };
    process.once(signal, handler);
    return () => process.off(signal, handler);
  });
  return () => {
    for (const remove of handlers) remove();
  };
}

function resolvePath(repoDir: string, cwd: string, configPath: string | undefined): string {
  if (configPath === undefined) return join(repoDir, DEFAULT_CONFIG_FILE);
  return isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
}
