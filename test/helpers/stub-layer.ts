import { z } from "zod";
import { defineLayer, type Layer } from "../../src/layers/layer.js";
import type { Finding, FindingClass, LayerResult } from "../../src/model/finding.js";

export function createFinding(findingClass: FindingClass, overrides: Partial<Finding> = {}): Finding {
  return {
    layer: "stub",
    scope: "api",
    id: `rule-${findingClass}`,
    subject: "GET /things",
    class: findingClass,
    message: `a ${findingClass} change`,
    evidence: [{ side: "revision", ref: "v2", commit: "b".repeat(40), path: "openapi.yaml", line: 3 }],
    ...overrides,
  };
}

export function createStubLayer(name = "stub", result?: (config: { level?: string }) => LayerResult): Layer {
  return defineLayer({
    name,
    description: "test layer",
    configSchema: z.strictObject({
      level: z.string().optional(),
      nested: z.strictObject({ value: z.number() }).optional(),
    }),
    async run({ config }) {
      if (result) return result(config);
      const findings = config.level ? [createFinding(config.level as FindingClass, { layer: name })] : [];
      return { layer: name, status: "ran", findings, notes: [] };
    },
  }) as unknown as Layer;
}

export function createIo(cwd: string, layers?: Layer[]) {
  const out: string[] = [];
  const errOut: string[] = [];
  return {
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => errOut.push(text),
      cwd,
      env: process.env,
      layers,
    },
    stdout: () => out.join(""),
    stderr: () => errOut.join(""),
  };
}
