import { countAccepted, countReclassifiedBy, getLayerVerdict } from "../model/gate.js";
import type { Report } from "./report.js";

export const JSON_REPORT_SCHEMA_VERSION = 1;

export function renderJson(report: Report): string {
  const document = {
    schemaVersion: JSON_REPORT_SCHEMA_VERSION,
    base: report.base,
    revision: report.revision,
    failOn: report.failOn,
    allowIncomplete: report.allowIncomplete,
    required: report.required,
    gate: report.gate,
    layers: [
      ...report.layers.map((result) => ({
        ...result,
        verdict: getLayerVerdict(result),
        acceptedCount: countAccepted(result),
        reclassifiedCount: countReclassifiedBy(report.layers, result.layer),
      })),
      ...report.inactive.map(({ layer, status }) => ({
        layer,
        status,
        verdict: status,
        findings: [],
        notes: [],
      })),
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
