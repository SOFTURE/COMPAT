import { compareClass, type Finding } from "../../model/finding.js";
import { CONFIG_FINDING_IDS, type KeyIndex, type SourcedDeclaration } from "./classify.js";
import type { ConfigWatchEntry } from "./config.js";
import { type KeyMatching, normalizeKey } from "./keys.js";

const KEY_FINDING_IDS: ReadonlySet<string> = new Set(CONFIG_FINDING_IDS);

/**
 * Matches a key identity against a `watch` pattern; `*` matches any run of characters, `?` one.
 * In normalized mode the literal parts of the pattern are normalized like keys, so `Consumers:*`
 * and `CONSUMERS_*` watch the same keys.
 */
export function createKeyMatcher(pattern: string, matching: KeyMatching): (key: string) => boolean {
  const source = pattern
    .split(/([*?])/)
    .map((part) => {
      if (part === "*") return ".*";
      if (part === "?") return ".";
      const literal = matching === "normalized" ? normalizePatternPart(part) : part;
      return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const regex = new RegExp(`^${source}$`, matching === "normalized" ? "iu" : "u");
  return (key) => regex.test(key);
}

/** Normalizes a literal part of a pattern, keeping a separator at its edges as `_`. */
function normalizePatternPart(part: string): string {
  if (part === "") return "";
  const separator = /[^\p{L}\p{N}]/u;
  if (!/[\p{L}\p{N}]/u.test(part)) return "_";
  const lead = separator.test(part[0] as string) ? "_" : "";
  const trail = separator.test(part.at(-1) as string) ? "_" : "";
  return `${lead}${normalizeKey(part)}${trail}`;
}

/** The defaults of a key at one ref: each distinct default quoted, `no default`, or `absent`. */
function describeDefaults(declarations: SourcedDeclaration[] | undefined): string {
  if (declarations === undefined || declarations.length === 0) return "absent";
  const values = new Set<string>();
  for (const declaration of declarations) {
    values.add(declaration.default === null ? "no default" : JSON.stringify(declaration.default));
  }
  return [...values].sort().join(", ");
}

export type ApplyWatchOptions = {
  watch: ConfigWatchEntry[];
  matching: KeyMatching;
  base: KeyIndex;
  revision: KeyIndex;
};

/**
 * Raises every key finding of a watched key to at least the class of the entry and prints the
 * defaults at both refs: a watched key is declared non-secret, so its defaults may be shown.
 */
export function applyWatch(
  findings: Finding[],
  { watch, matching, base, revision }: ApplyWatchOptions,
): Finding[] {
  const entries = watch.map((entry) => ({ entry, matches: createKeyMatcher(entry.key, matching) }));
  return findings.map((finding) => {
    if (!KEY_FINDING_IDS.has(finding.id)) return finding;
    const matched = entries.filter(({ matches }) => matches(finding.subject));
    if (matched.length === 0) return finding;
    let findingClass = finding.class;
    let message = finding.message;
    for (const { entry } of matched) {
      if (compareClass(entry.class, findingClass) > 0) findingClass = entry.class;
      message += `; watched key (${entry.key})${entry.reason === undefined ? "" : `: ${entry.reason}`}`;
    }
    message += `; default ${describeDefaults(base.get(finding.subject))} → ${describeDefaults(revision.get(finding.subject))}`;
    return { ...finding, class: findingClass, message };
  });
}
