import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_CONFIG_FILE, loadConfig } from "../config/config.js";
import { openRefTree, resolveRepoRoot } from "../git/ref-tree.js";
import type { Layer } from "../layers/layer.js";
import { LAYERS } from "../layers/registry.js";
import type { LayerResult } from "../model/finding.js";
import { evaluateGate, type FailOn } from "../model/gate.js";
import { killAllProcessGroups } from "../process/run-process.js";
import { renderJson } from "../report/json.js";
import { renderMarkdown } from "../report/markdown.js";

export const REPORT_FORMATS = ["md", "json"] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export type CheckOptions = {
  base: string;
  revision: string;
  repoDir?: string;
  configPath?: string;
  format: ReportFormat;
  outputPath?: string;
  failOn: FailOn;
  allowIncomplete: boolean;
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
};

export const EXIT_CANNOT_RUN = 2;

export async function runCheck(options: CheckOptions, io: CheckIo): Promise<number> {
  const repoDir = resolve(io.cwd, options.repoDir ?? ".");
  const configPath = resolvePath(repoDir, io.cwd, options.configPath);
  const layers = io.layers ?? LAYERS;

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

  const repoRoot = await resolveRepoRoot(repoDir);
  if (!repoRoot.ok) {
    io.stderr(`softure-compat: ${repoRoot.error}\n`);
    return EXIT_CANNOT_RUN;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "softure-compat-"));
  const stopOnSignal = installTerminationHandlers(tempRoot, io);
  try {
    const base = await openRefTree({ repoDir: repoRoot.value, ref: options.base, side: "base", tempRoot });
    if (!base.ok) {
      io.stderr(`softure-compat: ${base.error}\n`);
      return EXIT_CANNOT_RUN;
    }
    const revision = await openRefTree({
      repoDir: repoRoot.value,
      ref: options.revision,
      side: "revision",
      tempRoot,
    });
    if (!revision.ok) {
      io.stderr(`softure-compat: ${revision.error}\n`);
      return EXIT_CANNOT_RUN;
    }

    const results: LayerResult[] = [];
    for (const { layer, config: layerConfig } of config.value.layers) {
      const tempDir = join(tempRoot, `layer-${layer.name}`);
      await mkdir(tempDir, { recursive: true });
      try {
        results.push(
          await layer.run({
            config: layerConfig,
            base: base.value,
            revision: revision.value,
            repoDir: repoRoot.value,
            tempDir,
            env: io.env,
            log: (message) => io.stderr(`[${layer.name}] ${message}\n`),
          }),
        );
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

    const gate = evaluateGate(results, { failOn: options.failOn, allowIncomplete: options.allowIncomplete });
    const report = {
      base: { ref: options.base, commit: base.value.commit },
      revision: { ref: options.revision, commit: revision.value.commit },
      failOn: options.failOn,
      allowIncomplete: options.allowIncomplete,
      gate,
      layers: results,
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
