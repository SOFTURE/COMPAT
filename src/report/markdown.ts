import {
  type Evidence,
  FINDING_CLASSES,
  type Finding,
  type LayerResult,
  type Side,
} from "../model/finding.js";
import { getLayerVerdict, type InactiveLayer } from "../model/gate.js";
import type { RefInfo, Report } from "./report.js";

const CLASSES_BY_SEVERITY = [...FINDING_CLASSES].reverse();

/**
 * Escapes text placed inside a Markdown table cell or a list item. Spec-controlled text must
 * not open HTML (which can hide the rest of a PR comment) or mention people and teams.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/(^|\s)@(?=[\w-])/g, "$1@\u200b")
    .replace(/\r?\n/g, " ");
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function formatEvidence(evidence: Evidence): string {
  const location = evidence.line === undefined ? evidence.path : `${evidence.path}:${evidence.line}`;
  return `\`${location.replace(/`/g, "'")}\` @ ${escapeMarkdown(evidence.ref)}`;
}

function formatFinding(finding: Finding): string {
  const evidence = finding.evidence.length > 0 ? ` (${finding.evidence.map(formatEvidence).join(", ")})` : "";
  const line = `- **${escapeMarkdown(finding.layer)} / ${escapeMarkdown(finding.scope)}** \`${finding.id.replace(/`/g, "'")}\` ${escapeMarkdown(finding.subject)}: ${escapeMarkdown(finding.message)}${evidence}`;
  const details: string[] = [];
  if (finding.reclassified) {
    const { from, by, reason } = finding.reclassified;
    details.push(`  - reclassified from ${from} by ${escapeMarkdown(by)}: ${escapeMarkdown(reason)}`);
  }
  if (finding.accepted) details.push(`  - accepted: ${escapeMarkdown(finding.accepted.reason)}`);
  return [line, ...details].join("\n");
}

function countByClass(result: LayerResult): string[] {
  if (result.status === "skipped") return CLASSES_BY_SEVERITY.map(() => "-");
  return CLASSES_BY_SEVERITY.map((findingClass) =>
    String(result.findings.filter((finding) => !finding.accepted && finding.class === findingClass).length),
  );
}

function formatRequired(required: string[]): string {
  if (required.length === 0) return "";
  return `, required: ${required.map((layer) => `\`${layer.replace(/`/g, "'")}\``).join(", ")}`;
}

/**
 * `\`aaaa\` (--base)` for a plain ref, `github-deployment:prod → 2.2.4 \`aaaa\` (config)` for a resolved one;
 * the parentheses say where the ref was set.
 */
function formatRefInfo(info: RefInfo, side: Side): string {
  const commit = `\`${shortCommit(info.commit)}\``;
  const source = info.source === "config" ? "(config)" : `(--${side})`;
  if (info.resolver === undefined) return `${commit} ${source}`;
  return `${escapeMarkdown(info.resolver)} → ${escapeMarkdown(info.ref)} ${commit} ${source}`;
}

function formatInactiveStatus(layer: InactiveLayer): string {
  return layer.status === "disabled" ? "disabled" : "not configured";
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(
    `# Backward compatibility: ${escapeMarkdown(report.base.ref)} → ${escapeMarkdown(report.revision.ref)}`,
    "",
    `Base ${formatRefInfo(report.base, "base")}, revision ${formatRefInfo(report.revision, "revision")}, fail on \`${report.failOn}\`${formatRequired(report.required)}${report.allowIncomplete ? ", incomplete layers allowed" : ""}.`,
    "",
  );
  lines.push(report.gate.passed ? "**Gate: PASS**" : "**Gate: FAIL**");
  for (const reason of report.gate.reasons) lines.push(`- ${escapeMarkdown(reason)}`);
  if (report.inactive.length > 0) {
    const names = report.inactive.map(
      (layer) => `${escapeMarkdown(layer.layer)} (${formatInactiveStatus(layer)})`,
    );
    lines.push("", `Not checked: ${names.join(", ")}`);
  }
  lines.push(
    "",
    `| Layer | Verdict | ${CLASSES_BY_SEVERITY.join(" | ")} |`,
    `| --- | --- |${" --- |".repeat(4)}`,
  );
  for (const result of report.layers) {
    lines.push(
      `| ${escapeMarkdown(result.layer)} | ${getLayerVerdict(result)} | ${countByClass(result).join(" | ")} |`,
    );
  }
  for (const layer of report.inactive) {
    lines.push(`| ${escapeMarkdown(layer.layer)} | ${formatInactiveStatus(layer)} | - | - | - | - |`);
  }
  if (report.layers.length === 0 && report.inactive.length === 0)
    lines.push("| (none) | - | - | - | - | - |");

  const findings = report.layers.flatMap((result) => (result.status === "skipped" ? [] : result.findings));
  for (const findingClass of CLASSES_BY_SEVERITY) {
    const inClass = findings.filter((finding) => !finding.accepted && finding.class === findingClass);
    if (inClass.length === 0) continue;
    lines.push("", `## ${findingClass} (${inClass.length})`, "", ...inClass.map(formatFinding));
  }
  const accepted = findings.filter((finding) => finding.accepted);
  if (accepted.length > 0) {
    lines.push("", `## Accepted (${accepted.length})`, "", ...accepted.map(formatFinding));
  }
  const incomplete = report.layers.filter((result) => result.status !== "ran");
  if (incomplete.length > 0) {
    lines.push("", "## Not checked", "");
    for (const result of incomplete) {
      const why = result.status === "skipped" ? result.reason : result.error;
      lines.push(`- **${escapeMarkdown(result.layer)}** ${result.status}: ${escapeMarkdown(why)}`);
    }
  }
  const notes = report.layers.flatMap((result) =>
    result.status !== "skipped"
      ? result.notes.map((note) => `- **${escapeMarkdown(result.layer)}**: ${escapeMarkdown(note)}`)
      : [],
  );
  if (notes.length > 0) lines.push("", "## Notes", "", ...notes);
  return `${lines.join("\n")}\n`;
}
