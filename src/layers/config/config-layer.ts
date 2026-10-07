import type { RefTree } from "../../git/ref-tree.js";
import type { Finding, LayerResult } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer } from "../layer.js";
import {
  addDeclarations,
  applyAccept,
  CONFIG_LAYER,
  classifyKeys,
  getFileId,
  type KeyDeclaration,
  type KeyIndex,
} from "./classify.js";
import { type ConfigSource, compileRegexSource, configLayerConfigSchema } from "./config.js";
import { getKeyIdentity, type KeyIdentity } from "./keys.js";
import { applyPresence, hasResolvableFindings, type PresenceSettings, readPresentKeys } from "./presence.js";
import { scanCompose } from "./scan-compose.js";
import { scanDotenv } from "./scan-dotenv.js";
import { scanRegex } from "./scan-regex.js";

type SourceScan = { index: KeyIndex; files: string[] };

const MAX_LISTED_FILES = 5;

export const configLayer = defineLayer({
  name: CONFIG_LAYER,
  description:
    "Configuration keys: compose interpolation, .env examples and configured patterns at both refs",
  configSchema: configLayerConfigSchema,
  async run(context) {
    const base: KeyIndex = new Map();
    const revision: KeyIndex = new Map();
    const pairedFiles = new Set<string>();
    const notes: string[] = [];
    const errors: string[] = [];
    const identify = getKeyIdentity(context.config.keyMatching);
    // A source is used only when both refs were read; one side alone would invent added or removed keys.
    for (const source of context.config.sources) {
      const scanned = await scanSourceAtBothRefs(source, {
        base: context.base,
        revision: context.revision,
        identify,
      });
      if (!scanned.ok) {
        errors.push(`source "${source.name}": ${scanned.error}`);
        continue;
      }
      const [atBase, atRevision] = scanned.value;
      mergeIndex(base, atBase.index);
      mergeIndex(revision, atRevision.index);
      const atBaseFiles = new Set(atBase.files);
      for (const path of atRevision.files) {
        if (atBaseFiles.has(path)) pairedFiles.add(getFileId(source.name, path));
      }
      notes.push(describeSource(source, atBase, atRevision));
    }
    const classified = classifyKeys({
      base,
      revision,
      baseTree: context.base,
      revisionTree: context.revision,
      pairedFiles,
    });
    const resolved = await resolvePresence(classified, {
      context: { repoDir: context.repoDir, env: context.env, presence: context.config.presence },
      identify,
      notes,
    });
    const { findings, usage } = applyAccept(resolved, context.config.accept ?? [], identify);
    for (const { entry, count } of usage) {
      notes.push(
        count === 0
          ? `accept entry ${entry.id} on ${entry.key} matched nothing; remove it if the change is gone`
          : `accept entry ${entry.id} on ${entry.key} accepted ${count} finding(s)`,
      );
    }
    if (errors.length > 0) {
      return {
        layer: CONFIG_LAYER,
        status: "failed",
        error: errors.join("; "),
        findings,
        notes,
      } satisfies LayerResult;
    }
    return { layer: CONFIG_LAYER, status: "ran", findings, notes } satisfies LayerResult;
  },
});

type ResolvePresenceOptions = {
  context: { repoDir: string; env: NodeJS.ProcessEnv; presence: PresenceSettings | undefined };
  identify: KeyIdentity;
  notes: string[];
};

/**
 * Runs the presence command once, only when a finding needs a value in production. A failing
 * command is a note: the findings keep their class.
 */
async function resolvePresence(
  findings: Finding[],
  { context, identify, notes }: ResolvePresenceOptions,
): Promise<Finding[]> {
  if (context.presence === undefined || !hasResolvableFindings(findings)) return findings;
  const present = await readPresentKeys({
    presence: context.presence,
    cwd: context.repoDir,
    env: context.env,
    identify,
  });
  if (!present.ok) {
    notes.push(`${present.error}; keys that need a value in production stay unresolved`);
    return findings;
  }
  notes.push(`presence command listed ${present.value.size} key(s) in the target environment`);
  return applyPresence(findings, present.value);
}

/**
 * Scans one source at both refs. A source that cannot speak for the revision fails instead of
 * returning nothing: no file at either ref, files at the base but none in the revision (moved
 * out of the globs), keys at the base but none in the revision (a pattern that stopped matching),
 * or a dotenv or regex source that finds no key at either ref. A compose file without variables
 * is legitimate.
 */
async function scanSourceAtBothRefs(
  source: ConfigSource,
  { base, revision, identify }: { base: RefTree; revision: RefTree; identify: KeyIdentity },
): Promise<Result<[SourceScan, SourceScan]>> {
  const scan = getScanner(source);
  if (!scan.ok) return scan;
  const atBase = await scanSource(source, base, { scan: scan.value, identify });
  if (!atBase.ok) return atBase;
  const atRevision = await scanSource(source, revision, { scan: scan.value, identify });
  if (!atRevision.ok) return atRevision;
  const globs = source.files.map((glob) => `"${glob}"`).join(", ");
  if (atRevision.value.files.length === 0) {
    return err(
      atBase.value.files.length === 0
        ? `no file matches ${globs} at either ref`
        : `no file matches ${globs} in the revision, but ${atBase.value.files.length} did at the base; update the globs if the files moved`,
    );
  }
  if (atRevision.value.index.size === 0 && atBase.value.index.size > 0) {
    return err(
      `found ${atBase.value.index.size} key(s) in ${globs} at the base but none in the revision; check the files and the source settings`,
    );
  }
  if (source.kind !== "compose" && atBase.value.index.size === 0 && atRevision.value.index.size === 0) {
    return err(
      source.kind === "regex"
        ? `the pattern matches no key in ${globs} at either ref`
        : `no key found in ${globs} at either ref`,
    );
  }
  return ok([atBase.value, atRevision.value]);
}

async function scanSource(
  source: ConfigSource,
  tree: RefTree,
  { scan, identify }: { scan: (text: string) => KeyDeclaration[]; identify: KeyIdentity },
): Promise<Result<SourceScan>> {
  const files = await tree.listFiles(source.files);
  if (!files.ok) return err(`cannot list files at ${tree.ref}: ${files.error}`);
  const index: KeyIndex = new Map();
  for (const path of files.value) {
    const content = await tree.readFile(path);
    if (!content.ok) return content;
    if (content.value === null) continue;
    const declarations = scan(content.value).map((declaration) => withPrefix(declaration, source.prefix));
    addDeclarations(index, declarations, { source: source.name, path }, identify);
  }
  return ok({ index, files: files.value });
}

function getScanner(source: ConfigSource): Result<(text: string) => KeyDeclaration[]> {
  switch (source.kind) {
    case "compose":
      return ok(scanCompose);
    case "dotenv":
      return ok((text) => scanDotenv(text, { valuesAreDefaults: source.valuesAreDefaults }));
    case "regex": {
      // The schema already compiled the patterns; this repeats it only to get the RegExp objects.
      const result = compileRegexSource(source);
      if ("error" in result) return err(`${result.field} ${result.error}`);
      const { compiled } = result;
      return ok((text) => scanRegex(text, { ...compiled, comments: source.comments }));
    }
  }
}

function withPrefix(declaration: KeyDeclaration, prefix: string | undefined): KeyDeclaration {
  return prefix === undefined ? declaration : { ...declaration, key: `${prefix}${declaration.key}` };
}

function describeSource(source: ConfigSource, atBase: SourceScan, atRevision: SourceScan): string {
  const listed = atRevision.files.slice(0, MAX_LISTED_FILES).join(", ");
  const more =
    atRevision.files.length > MAX_LISTED_FILES ? `, +${atRevision.files.length - MAX_LISTED_FILES} more` : "";
  return (
    `source "${source.name}": ${atBase.index.size} key(s) in ${atBase.files.length} file(s) at base, ` +
    `${atRevision.index.size} key(s) in ${atRevision.files.length} file(s) at revision (${listed}${more})`
  );
}

function mergeIndex(target: KeyIndex, source: KeyIndex): void {
  for (const [key, declarations] of source) {
    target.set(key, [...(target.get(key) ?? []), ...declarations]);
  }
}
