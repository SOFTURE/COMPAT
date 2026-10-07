import { type Evidence, FINDING_CLASSES, type Finding, type LayerResult } from "../model/finding.js";
import { getLayerVerdict } from "../model/gate.js";
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
  return finding.accepted ? `${line}\n  - accepted: ${escapeMarkdown(finding.accepted.reason)}` : line;
}

function countByClass(result: LayerResult): string[] {
  if (result.status === "skipped") return CLASSES_BY_SEVERITY.map(() => "-");
  return CLASSES_BY_SEVERITY.map((findingClass) =>
    String(result.findings.filter((finding) => !finding.accepted && finding.class === findingClass).length),
  );
}

/** `\`aaaa\`` for a plain ref, `github-deployment:prod → 2.2.4 \`aaaa\`` for a resolved one. */
function formatRefInfo(info: RefInfo): string {
  const commit = `\`${shortCommit(info.commit)}\``;
  if (info.resolver === undefined) return commit;
  return `${escapeMarkdown(info.resolver)} → ${escapeMarkdown(info.ref)} ${commit}`;
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(
    `# Backward compatibility: ${escapeMarkdown(report.base.ref)} → ${escapeMarkdown(report.revision.ref)}`,
    "",
    `Base ${formatRefInfo(report.base)}, revision ${formatRefInfo(report.revision)}, fail on \`${report.failOn}\`${report.allowIncomplete ? ", incomplete layers allowed" : ""}.`,
    "",
  );
  lines.push(report.gate.passed ? "**Gate: PASS**" : "**Gate: FAIL**");
  for (const reason of report.gate.reasons) lines.push(`- ${escapeMarkdown(reason)}`);
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
  if (report.layers.length === 0) lines.push("| (none) | - | - | - | - | - |");

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
