import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Layer } from "../layers/layer.js";
import { FAIL_ON_VALUES, type FailOn, type InactiveLayer } from "../model/gate.js";
import { err, ok, type Result } from "../result.js";

export const DEFAULT_CONFIG_FILE = "compat.config.json";

/** Defaults for `check`; the command-line flags override them one by one. */
export type CheckDefaults = { base?: string; revision?: string; failOn?: FailOn };

export type CompatConfig = {
  check: CheckDefaults;
  /** Enabled layers with their parsed config, in registry order. */
  layers: { layer: Layer; config: Record<string, unknown> }[];
  /** Known layers that will not run, in registry order. */
  inactive: InactiveLayer[];
};

export function buildConfigSchema(layers: Layer[]) {
  const layerShape: Record<string, z.ZodOptional<z.ZodObject>> = {};
  for (const layer of layers) {
    layerShape[layer.name] = layer.configSchema.extend({ enabled: z.boolean().optional() }).optional();
  }
  return z.strictObject({
    $schema: z.string().optional(),
    check: z
      .strictObject({
        base: z.string().min(1).optional(),
        revision: z.string().min(1).optional(),
        failOn: z.enum(FAIL_ON_VALUES).optional(),
      })
      .optional(),
    layers: z.strictObject(layerShape),
  });
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return `${path === "" ? "(root)" : path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseConfig(raw: unknown, layers: Layer[], source: string): Result<CompatConfig> {
  const parsed = buildConfigSchema(layers).safeParse(raw);
  if (!parsed.success) return err(`invalid config ${source}: ${formatIssues(parsed.error)}`);
  const configured = parsed.data.layers as Record<
    string,
    (Record<string, unknown> & { enabled?: boolean }) | undefined
  >;
  const enabled: CompatConfig["layers"] = [];
  const inactive: InactiveLayer[] = [];
  for (const layer of layers) {
    const entry = configured[layer.name];
    if (entry === undefined) {
      inactive.push({ layer: layer.name, status: "not-configured" });
      continue;
    }
    if (entry.enabled === false) {
      inactive.push({ layer: layer.name, status: "disabled" });
      continue;
    }
    const { enabled: _enabled, ...config } = entry;
    enabled.push({ layer, config });
  }
  return ok({ check: parsed.data.check ?? {}, layers: enabled, inactive });
}

export async function loadConfig(path: string, layers: Layer[]): Promise<Result<CompatConfig>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return err(code === "ENOENT" ? `config file not found: ${path}` : `cannot read config ${path} (${code})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return err(`config ${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(raw, layers, path);
}
