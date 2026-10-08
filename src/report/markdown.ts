import {
  type CommandOutput,
  type Evidence,
  FINDING_CLASSES,
  type Finding,
  type LayerResult,
  type Side,
} from "../model/finding.js";
import { countAccepted, countReclassifiedBy, getLayerVerdict, type InactiveLayer } from "../model/gate.js";
import type { RefInfo, Report } from "./report.js";

const CLASSES_BY_SEVERITY = [...FINDING_CLASSES].reverse();

/**
 * Escapes text placed inside a Markdown table cell or a list item. Spec-controlled text must
 * not open HTML (which can hide the rest of a PR comment) or mention people and teams; a `<`
 * that cannot start a tag (`max(Id) < 418`) stays as it is.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/<(?=[A-Za-z!/?])/g, "\\<")
    .replace(/(^|\s)@(?=[\w-])/g, "$1@\u200b")
    .replace(/\r?\n/g, " ");
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

function formatLocation(evidence: Evidence): string {
  return evidence.line === undefined ? evidence.path : `${evidence.path}:${evidence.line}`;
}

/** One link per location, with every ref it was seen at: `` `a.ts:3` @ 2.0.1, 2.1.0 ``. */
function formatEvidence(evidence: Evidence[]): string {
  const refsByLocation = new Map<string, string[]>();
  for (const item of evidence) {
    const refs = refsByLocation.get(formatLocation(item)) ?? [];
    if (!refs.includes(item.ref)) refs.push(item.ref);
    refsByLocation.set(formatLocation(item), refs);
  }
  return [...refsByLocation]
    .map(([location, refs]) => `\`${location.replace(/`/g, "'")}\` @ ${refs.map(escapeMarkdown).join(", ")}`)
    .join("; ");
}

function formatFinding(finding: Finding, indent = ""): string {
  const evidence = finding.evidence.length > 0 ? ` (${formatEvidence(finding.evidence)})` : "";
  const line = `${indent}- **${escapeMarkdown(finding.layer)} / ${escapeMarkdown(finding.scope)}** \`${finding.id.replace(/`/g, "'")}\` ${escapeMarkdown(finding.subject)}: ${escapeMarkdown(finding.message)}${evidence}`;
  const details: string[] = [];
  if (finding.reclassified) {
    const { from, by, reason } = finding.reclassified;
    details.push(
      `${indent}  - reclassified from ${from} by ${escapeMarkdown(by)}: ${escapeMarkdown(reason)}`,
    );
  }
  if (finding.accepted) details.push(`${indent}  - accepted: ${escapeMarkdown(finding.accepted.reason)}`);
  return [line, ...details].join("\n");
}

function getTopic(finding: Finding): string {
  return finding.topic ?? finding.subject;
}

/**
 * Findings of several layers about one topic (an enum member a seed row writes) become one entry;
 * everything else stays one entry per finding, in the order given.
 */
function groupByTopic(findings: Finding[]): Finding[][] {
  const layersByTopic = new Map<string, Set<string>>();
  for (const finding of findings) {
    const layers = layersByTopic.get(getTopic(finding)) ?? new Set<string>();
    layersByTopic.set(getTopic(finding), layers.add(finding.layer));
  }
  const entries: Finding[][] = [];
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const topic = getTopic(finding);
    if ((layersByTopic.get(topic)?.size ?? 0) < 2) {
      entries.push([finding]);
      continue;
    }
    const group = grouped.get(topic);
    if (group !== undefined) {
      group.push(finding);
      continue;
    }
    const created = [finding];
    grouped.set(topic, created);
    entries.push(created);
  }
  return entries;
}

function formatEntry(entry: Finding[]): string {
  const [first] = entry;
  if (first === undefined) return "";
  if (entry.length === 1) return formatFinding(first);
  const layers = [...new Set(entry.map((finding) => escapeMarkdown(finding.layer)))].join(", ");
  const views = entry.map((finding) => formatFinding(finding, "  "));
  return [`- **${escapeMarkdown(getTopic(first))}** (${layers})`, ...views].join("\n");
}

/** `- error-codes: 36 × error-code-unknown-to-client, 18 × error-code-added`, most frequent rule first. */
function formatRuleCounts(findings: Finding[]): string[] {
  const countsByLayer = new Map<string, Map<string, number>>();
  for (const finding of findings) {
    const counts = countsByLayer.get(finding.layer) ?? new Map<string, number>();
    countsByLayer.set(finding.layer, counts.set(finding.id, (counts.get(finding.id) ?? 0) + 1));
  }
  return [...countsByLayer].map(([layer, counts]) => {
    const rules = [...counts]
      .sort(([, a], [, b]) => b - a)
      .map(([id, count]) => `${count} × \`${id.replace(/`/g, "'")}\``);
    return `- ${escapeMarkdown(layer)}: ${rules.join(", ")}`;
  });
}

/** A section with its entries in full. */
function formatSection(title: string, findings: Finding[]): string[] {
  const entries = groupByTopic(findings);
  return ["", `## ${title} (${entries.length})`, "", ...entries.map(formatEntry)];
}

/** A section that shows rule counts and folds its entries into a `<details>` block. */
function formatCollapsedSection(title: string, findings: Finding[]): string[] {
  const entries = groupByTopic(findings);
  return [
    "",
    `## ${title} (${entries.length})`,
    "",
    ...formatRuleCounts(findings),
    "",
    `<details><summary>All ${title.toLowerCase()} findings</summary>`,
    "",
    ...entries.map(formatEntry),
    "",
    "</details>",
  ];
}

/** The class columns from the most severe, then the accepted column. */
function countByClass(result: LayerResult): string[] {
  if (result.status === "skipped") return [...CLASSES_BY_SEVERITY.map(() => "-"), "-"];
  const counts = CLASSES_BY_SEVERITY.map((findingClass) =>
    String(result.findings.filter((finding) => !finding.accepted && finding.class === findingClass).length),
  );
  return [...counts, String(countAccepted(result))];
}

/**
 * The verdict, except that a layer with no findings of its own that changed the class of other layers' findings
 * (`client-usage`) reads `reclassified 6`, so its row does not suggest it saw nothing.
 */
function formatVerdict(result: LayerResult, layers: readonly LayerResult[]): string {
  const verdict = getLayerVerdict(result);
  const reclassified = countReclassifiedBy(layers, result.layer);
  return verdict === "no-findings" && reclassified > 0 ? `reclassified ${reclassified}` : verdict;
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

/** The last lines a failed command printed, as a code block inside the list item, with its newlines kept. */
function formatCommandOutput(output: CommandOutput): string[] {
  const log = output.log === undefined ? "" : ` (full output: \`${output.log.replace(/`/g, "'")}\`)`;
  const heading = `  Last lines of ${escapeMarkdown(output.command)}${log}:`;
  if (output.tail === "") return ["", heading.replace(/:$/, ": nothing printed")];
  // A fence longer than any backtick run in the output, so the output cannot close it.
  const longest = Math.max(0, ...(output.tail.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const body = output.tail.split("\n").map((line) => `  ${line}`.trimEnd());
  return ["", heading, "", `  ${fence}text`, ...body, `  ${fence}`];
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
    `| Layer | Verdict | ${CLASSES_BY_SEVERITY.join(" | ")} | accepted |`,
    `| --- | --- |${" --- |".repeat(5)}`,
  );
  for (const result of report.layers) {
    lines.push(
      `| ${escapeMarkdown(result.layer)} | ${formatVerdict(result, report.layers)} | ${countByClass(result).join(" | ")} |`,
    );
  }
  for (const layer of report.inactive) {
    lines.push(`| ${escapeMarkdown(layer.layer)} | ${formatInactiveStatus(layer)} | - | - | - | - | - |`);
  }
  if (report.layers.length === 0 && report.inactive.length === 0)
    lines.push("| (none) | - | - | - | - | - | - |");

  const findings = report.layers.flatMap((result) => (result.status === "skipped" ? [] : result.findings));
  for (const findingClass of CLASSES_BY_SEVERITY) {
    const inClass = findings.filter((finding) => !finding.accepted && finding.class === findingClass);
    if (inClass.length === 0) continue;
    lines.push(
      ...(findingClass === "safe"
        ? formatCollapsedSection(findingClass, inClass)
        : formatSection(findingClass, inClass)),
    );
  }
  const accepted = findings.filter((finding) => finding.accepted);
  if (accepted.length > 0) lines.push(...formatCollapsedSection("Accepted", accepted));
  const incomplete = report.layers.filter((result) => result.status !== "ran");
  if (incomplete.length > 0) {
    lines.push("", "## Not checked", "");
    for (const result of incomplete) {
      const why = result.status === "skipped" ? result.reason : result.error;
      lines.push(`- **${escapeMarkdown(result.layer)}** ${result.status}: ${escapeMarkdown(why)}`);
      if (result.status === "failed") lines.push(...(result.outputs ?? []).flatMap(formatCommandOutput));
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
