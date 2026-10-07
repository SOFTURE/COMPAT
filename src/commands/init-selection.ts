import { posix } from "node:path";
import type { RefTree } from "../git/ref-tree.js";
import { compileRegexSource } from "../layers/config/config.js";
import { scanRegex } from "../layers/config/scan-regex.js";
import { ok, type Result } from "../result.js";

/** Test-only packages: their upgrades change no production behaviour, so `init` writes them as `ignore`. */
export const DEFAULT_DEPENDENCY_IGNORE = [
  "Microsoft.NET.Test.Sdk",
  "xunit*",
  "nunit*",
  "MSTest*",
  "coverlet.*",
  "*.Analyzers",
  "Microsoft.CodeAnalysis.*",
];

const TEST_SEGMENT = /^(?:tests?|e2e|mocks?|__tests__|__mocks__)$|\.Tests?$/i;
const TEST_NAME_PART = /^(?:tests?|e2e|mocks?)$/i;
const MOBILE_PACKAGES = ["expo", "react-native"];
const ANSIBLE_SEGMENT = /^(?:ansible|roles|playbooks?)$/i;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const YAML_FILE = /\.ya?ml$/i;
const ASSERT_TASK = /^[ \t]*-?[ \t]*(?:ansible\.builtin\.)?assert:/m;
const COMPOSE_REFERENCE = /[\w.{}$/-]*(?:docker-compose|compose)(?:\.[\w-]+)?\.ya?ml/g;
const PROJECT_SRC = /project_src:[ \t]*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#]+))/g;
const ENVIRONMENT =
  /^[ \t]*environment:[ \t]*(?:\r?\n[ \t]*name:[ \t]*)?["']?([A-Za-z0-9_.-]+)["']?[ \t]*$/gm;

/** A regex config source as `init` writes it. */
export type DeployRegexSource = {
  kind: "regex";
  name: string;
  files: string[];
  pattern: string;
  flags: string;
  comments: "hash";
};

/** What the deploy tooling of a repository says about configuration. */
export type DeployChain = {
  sources: DeployRegexSource[];
  /** The assert source, when one exists: a key it misses breaks the deploy. */
  required: string | null;
  /** Compose files the deploy tooling references, in repository terms. */
  composeFiles: string[];
  /** The GitHub environment the workflows deploy to, preferring one named like production. */
  environment: string | null;
};

type DeployPattern = { name: string; pattern: string; flags: string };

const ANSIBLE_TEMPLATE: DeployPattern = {
  name: "ansible-template",
  pattern: "^[ \\t]*(?:export[ \\t]+)?(?<key>[A-Za-z_][A-Za-z0-9_]*)[ \\t]*=[ \\t]*[\"']?\\{\\{",
  flags: "m",
};
const ANSIBLE_ENV: DeployPattern = {
  name: "ansible-env",
  pattern: "lookup\\([ \\t]*[\"']env[\"'][ \\t]*,[ \\t]*[\"'](?<key>[A-Za-z_][A-Za-z0-9_]*)[\"']",
  flags: "",
};
const ANSIBLE_ASSERT: DeployPattern = {
  name: "ansible-assert",
  pattern:
    "^[ \\t]*-[ \\t]*[\"']?(?<key>[A-Za-z_][A-Za-z0-9_]*)[ \\t]*(?:\\|[ \\t]*length[ \\t]*>[ \\t]*0|is[ \\t]+defined)",
  flags: "m",
};
const WORKFLOW_SECRETS: DeployPattern = {
  name: "workflow-secrets",
  pattern: "^[ \\t]*(?<key>[A-Z][A-Z0-9_]*)[ \\t]*:[ \\t]*[\"']?\\$\\{\\{[ \\t]*secrets\\.",
  flags: "m",
};

const getFolder = (path: string) => posix.dirname(path);

/** A file in a test folder (`tests`, `e2e`, `*.Tests`, ...) or named like one (`compose.integration-tests.yml`). */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const fileName = segments.pop() ?? "";
  return (
    segments.some((segment) => TEST_SEGMENT.test(segment)) ||
    fileName.split(/[._-]/).some((part) => TEST_NAME_PART.test(part))
  );
}

/** Whether `path` lies in the folder of `manifest`; a manifest at the repository root claims no folder. */
export function isInFolderOf(path: string, manifest: string): boolean {
  const folder = getFolder(manifest);
  return path === manifest || (folder !== "." && path.startsWith(`${folder}/`));
}

/** The `package.json` files of React Native or Expo apps: client builds, not part of a server release. */
export async function findMobileApps(tree: RefTree, packageFiles: string[]): Promise<Result<string[]>> {
  const mobile: string[] = [];
  for (const path of packageFiles) {
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(text.value ?? "") as Record<string, unknown>;
    } catch {
      continue; // The dependencies layer reports an invalid package.json; here it is just not a mobile app.
    }
    const sections = [manifest.dependencies, manifest.devDependencies];
    const isMobile = sections.some(
      (section) =>
        typeof section === "object" &&
        section !== null &&
        MOBILE_PACKAGES.some((name) => Object.hasOwn(section, name)),
    );
    if (isMobile) mobile.push(path);
  }
  return ok(mobile);
}

/** Path segments a reference names in repository terms: the part after its last templated segment. */
function getReferenceSegments(reference: string): string[] {
  const segments = reference.split("/");
  // A templated or `..` segment depends on where the tooling runs; only what follows it is known.
  const lastTemplated = segments.findLastIndex((segment) => /[{}$]/.test(segment) || segment === "..");
  return segments.slice(lastTemplated + 1).filter((segment) => segment !== "" && segment !== ".");
}

const endsWithSegments = (path: string, tail: string[]) =>
  tail.length > 0 && path.split("/").slice(-tail.length).join("/") === tail.join("/");

const countCommonSegments = (a: string, b: string) => {
  const left = a.split("/");
  const right = b.split("/");
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
};

/** Of the candidates, the ones closest to the file that references them (a bare file name can match many). */
function pickNearest(candidates: string[], referencedFrom: string): string[] {
  const scores = candidates.map((path) => countCommonSegments(getFolder(path), getFolder(referencedFrom)));
  const best = Math.max(...scores);
  return candidates.filter((_, index) => scores[index] === best);
}

/**
 * Compose files that deploy tooling references: a compose file name (`docker compose -f`, an Ansible
 * `copy`/`template` source) or an Ansible `project_src` folder.
 */
function findReferencedCompose(text: string, referencedFrom: string, composeFiles: string[]): string[] {
  const found = new Set<string>();
  const add = (candidates: string[]) => {
    if (candidates.length > 0) for (const path of pickNearest(candidates, referencedFrom)) found.add(path);
  };
  for (const match of text.matchAll(COMPOSE_REFERENCE)) {
    const tail = getReferenceSegments(match[0]);
    add(composeFiles.filter((path) => endsWithSegments(path, tail)));
  }
  for (const match of text.matchAll(PROJECT_SRC)) {
    const tail = getReferenceSegments((match[1] ?? match[2] ?? match[3]) as string);
    add(composeFiles.filter((path) => endsWithSegments(getFolder(path), tail)));
  }
  return [...found];
}

/** Files of `paths` where `pattern` finds at least one key. */
async function filterFilesWithKeys(
  tree: RefTree,
  paths: string[],
  pattern: DeployPattern,
): Promise<Result<string[]>> {
  const compiled = compileRegexSource(pattern);
  // The patterns are constants; one that does not compile is a bug, caught by the tests.
  if ("error" in compiled) throw new Error(`${pattern.name}: ${compiled.error}`);
  const matching: string[] = [];
  for (const path of paths) {
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    if (text.value === null) continue;
    const keys = scanRegex(text.value, { regex: compiled.compiled.regex, comments: "hash" });
    if (keys.length > 0) matching.push(path);
  }
  return ok(matching);
}

async function readAll(tree: RefTree, paths: string[]): Promise<Result<Map<string, string>>> {
  const texts = new Map<string, string>();
  for (const path of paths) {
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    if (text.value !== null) texts.set(path, text.value);
  }
  return ok(texts);
}

/** The deploy environment of the workflows: one named like production, else the first by name. */
function pickEnvironment(workflowTexts: string[]): string | null {
  const names = new Set<string>();
  for (const text of workflowTexts)
    for (const match of text.matchAll(ENVIRONMENT)) names.add(match[1] as string);
  const sorted = [...names].sort();
  return sorted.find((name) => /prod/i.test(name)) ?? sorted[0] ?? null;
}

/**
 * Reads the deploy chain: Ansible templates (`KEY={{ var }}`), `lookup('env', 'KEY')`, `assert`
 * tasks and GitHub workflows that pass `secrets.*` as environment variables. Each kind that finds
 * a key becomes a regex source over the files where it does.
 */
export async function detectDeployChain(
  tree: RefTree,
  files: string[],
  composeFiles: string[],
): Promise<Result<DeployChain>> {
  const ansibleRoots = files.filter((path) => posix.basename(path) === "ansible.cfg").map(getFolder);
  const isAnsible = (path: string) =>
    getFolder(path)
      .split("/")
      .some((segment) => ANSIBLE_SEGMENT.test(segment)) ||
    ansibleRoots.some((root) => root === "." || path.startsWith(`${root}/`));
  const ansibleYaml = files.filter((path) => YAML_FILE.test(path) && isAnsible(path));
  const templates = files.filter(
    (path) => path.endsWith(".j2") && (isAnsible(path) || getFolder(path).split("/").includes("templates")),
  );
  const workflows = files.filter((path) => WORKFLOW_FILE.test(path));

  const ansibleTexts = await readAll(tree, ansibleYaml);
  if (!ansibleTexts.ok) return ansibleTexts;
  const workflowTexts = await readAll(tree, workflows);
  if (!workflowTexts.ok) return workflowTexts;
  const assertFiles = ansibleYaml.filter((path) => ASSERT_TASK.test(ansibleTexts.value.get(path) ?? ""));

  const candidates: [DeployPattern, string[]][] = [
    [ANSIBLE_TEMPLATE, templates],
    [ANSIBLE_ENV, ansibleYaml],
    [ANSIBLE_ASSERT, assertFiles],
    [WORKFLOW_SECRETS, workflows],
  ];
  const sources: DeployRegexSource[] = [];
  for (const [pattern, paths] of candidates) {
    const matching = await filterFilesWithKeys(tree, paths, pattern);
    if (!matching.ok) return matching;
    if (matching.value.length > 0) {
      sources.push({ kind: "regex", ...pattern, files: matching.value, comments: "hash" });
    }
  }

  const referenced = new Set<string>();
  for (const [path, text] of [...ansibleTexts.value, ...workflowTexts.value]) {
    for (const compose of findReferencedCompose(text, path, composeFiles)) referenced.add(compose);
  }
  const secretWorkflows = sources.find((source) => source.name === WORKFLOW_SECRETS.name)?.files ?? [];
  return ok({
    sources,
    required: sources.some((source) => source.name === ANSIBLE_ASSERT.name) ? ANSIBLE_ASSERT.name : null,
    composeFiles: [...referenced].sort(),
    environment: pickEnvironment(secretWorkflows.map((path) => workflowTexts.value.get(path) ?? "")),
  });
}
