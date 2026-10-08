import type { RefTree } from "../../git/ref-tree.js";
import { ok, type Result } from "../../result.js";
import { createLineLocator, stripComments } from "../config/comments.js";
import type { Site } from "./compare-contracts.js";

/** Generic broker APIs whose type arguments name messages: MassTransit's consumers, contexts and clients. */
export const BROKER_GENERIC = /\b(IConsumer|ConsumeContext|IRequestClient|Publish|Send)\s*</g;
/** `Publish(new T ...)` and `Send(new T ...)`: the message type follows `new`. */
export const BROKER_NEW = /\b(?:Publish|Send)\s*\(\s*new\s+([\w.]+)/g;

/** APIs of `BROKER_GENERIC` that put a message on the wire; `IConsumer` takes it off. */
const SENDING_APIS = new Set(["IRequestClient", "Publish", "Send"]);
const IGNORED_SEGMENTS = new Set(["node_modules", "bin", "obj", "dist"]);
/** Test projects publish and consume through a harness, not in production. */
const TEST_PROJECT = /(?:^|[._-])Tests?$/i;

/** The text between the `<` at `open` and its matching `>`; empty when the statement ends first. */
export function readTypeArguments(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "<") depth++;
    else if (text[index] === ">" && --depth === 0) return text.slice(open + 1, index);
    else if (text[index] === ";" || text[index] === "{") break;
  }
  return "";
}

/** The projects that publish or consume one message type, each with the first place it does. */
export type MessageUsage = { publishers: Map<string, Site>; consumers: Map<string, Site> };

const getProjectName = (csproj: string) => (csproj.split("/").at(-1) ?? csproj).replace(/\.csproj$/i, "");
const getFolder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");

/**
 * Where the C# code of one ref publishes (`Publish`, `Send`, `IRequestClient`) and consumes
 * (`IConsumer`) the messages named in `simpleNames`, by project: the nearest folder with a `.csproj`.
 * Files outside a project, in build output or in a test project are skipped.
 */
export async function findBrokerUsage(
  tree: RefTree,
  simpleNames: Set<string>,
): Promise<Result<Map<string, MessageUsage>>> {
  const usage = new Map<string, MessageUsage>();
  if (simpleNames.size === 0) return ok(usage);
  const listed = await tree.listFiles(["**/*.csproj", "**/*.cs"]);
  if (!listed.ok) return listed;
  const paths = listed.value.filter((path) => !path.split("/").some((part) => IGNORED_SEGMENTS.has(part)));
  const projects = new Map(
    paths.filter((path) => path.toLowerCase().endsWith(".csproj")).map((path) => [getFolder(path), path]),
  );
  const folders = [...projects.keys()].sort((a, b) => b.length - a.length);
  const getProject = (path: string) => {
    const folder = folders.find((candidate) => candidate === "." || path.startsWith(`${candidate}/`));
    return folder === undefined ? undefined : getProjectName(projects.get(folder) as string);
  };
  const record = (name: string, role: keyof MessageUsage, project: string, site: Site) => {
    if (!simpleNames.has(name)) return;
    const entry = usage.get(name) ?? { publishers: new Map(), consumers: new Map() };
    usage.set(name, entry);
    if (!entry[role].has(project)) entry[role].set(project, site);
  };
  for (const path of paths) {
    if (!path.toLowerCase().endsWith(".cs")) continue;
    const project = getProject(path);
    if (project === undefined || TEST_PROJECT.test(project)) continue;
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    if (text.value === null) continue;
    const code = stripComments(text.value, "slash");
    const getLine = createLineLocator(code);
    for (const match of code.matchAll(BROKER_GENERIC)) {
      const api = match[1] as string;
      if (api === "ConsumeContext") continue;
      const role = SENDING_APIS.has(api) ? "publishers" : "consumers";
      const typeArguments = readTypeArguments(code, match.index + match[0].length - 1);
      for (const name of typeArguments.match(/[A-Za-z_]\w*/g) ?? []) {
        record(name, role, project, { path, line: getLine(match.index) });
      }
    }
    for (const match of code.matchAll(BROKER_NEW)) {
      const name = match[1]?.split(".").at(-1) ?? "";
      record(name, "publishers", project, { path, line: getLine(match.index) });
    }
  }
  return ok(usage);
}
