import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Layer } from "../layers/layer.js";
import { err, ok, type Result } from "../result.js";

export const DEFAULT_CONFIG_FILE = "compat.config.json";

export type CompatConfig = {
  /** Enabled layers with their parsed config, in registry order. */
  layers: { layer: Layer; config: Record<string, unknown> }[];
};

export function buildConfigSchema(layers: Layer[]) {
  const layerShape: Record<string, z.ZodOptional<z.ZodObject>> = {};
  for (const layer of layers) {
    layerShape[layer.name] = layer.configSchema.extend({ enabled: z.boolean().optional() }).optional();
  }
  return z.strictObject({
    $schema: z.string().optional(),
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
  for (const layer of layers) {
    const entry = configured[layer.name];
    if (entry === undefined || entry.enabled === false) continue;
    const { enabled: _enabled, ...config } = entry;
    enabled.push({ layer, config });
  }
  return ok({ layers: enabled });
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
