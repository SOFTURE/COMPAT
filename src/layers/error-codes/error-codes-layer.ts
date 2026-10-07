import { openRefTree, type RefTree } from "../../git/ref-tree.js";
import type { LayerResult } from "../../model/finding.js";
import { formatResolvers, resolveRefList } from "../../resolve/ref-list.js";
import { err, ok, type Result } from "../../result.js";
import { defineLayer, type LayerContext } from "../layer.js";
import {
  applyErrorCodeAccept,
  type ClientCodes,
  type ClientRefCodes,
  type CodeDeclaration,
  type CodeSet,
  classifyErrorCodes,
} from "./classify.js";
import { composeCodes } from "./compose-codes.js";
import {
  type ComposedCodeSource,
  compileCodePattern,
  ERROR_CODES_LAYER,
  type ErrorCodeClient,
  type ErrorCodesConfig,
  errorCodesConfigSchema,
  type RegexCodeSource,
} from "./config.js";
import { readCodes } from "./read-codes.js";
import { scopeErrorCodes } from "./scope.js";

type FileCodes = { path: string; codes: ReturnType<typeof readCodes> };

type CodeSides = { base: Map<string, CodeDeclaration>; revision: Map<string, CodeDeclaration> };

export const errorCodesLayer = defineLayer({
  name: ERROR_CODES_LAYER,
  description: "Typed error codes: codes new in the revision that live client builds cannot translate",
  configSchema: errorCodesConfigSchema,
  async run(context) {
    const notes: string[] = [];
    const errors: string[] = [];
    const base = new Map<string, CodeDeclaration>();
    const revision = new Map<string, CodeDeclaration>();
    let canCompare = true;
    const found = { base: new Map<string, CodeSet>(), revision: new Map<string, CodeSet>() };
    // Every source and client is read even when one fails, so the others still reach the report.
    for (const source of context.config.codes) {
      if (source.kind !== "regex") continue;
      const outcome = await readSource(context, source);
      if (!outcome.ok) {
        errors.push(`code source "${source.name}": ${outcome.error}`);
        canCompare = false;
        continue;
      }
      found.base.set(source.name, outcome.value.base);
      found.revision.set(source.name, outcome.value.revision);
      if (source.report) {
        addFirst(base, outcome.value.base);
        addFirst(revision, outcome.value.revision);
      }
      notes.push(
        `code source "${source.name}": ${outcome.value.base.size} code(s) at base, ${outcome.value.revision.size} at revision` +
          (source.report ? "" : " (a part, not reported)"),
      );
    }
    for (const source of context.config.codes) {
      if (source.kind !== "composed") continue;
      const outcome = composeSource(context, source, found);
      if (!outcome.ok) {
        errors.push(`code source "${source.name}": ${outcome.error}`);
        canCompare = false;
        continue;
      }
      addFirst(base, outcome.value.base);
      addFirst(revision, outcome.value.revision);
      notes.push(
        `code source "${source.name}": ${outcome.value.base.size} code(s) at base, ${outcome.value.revision.size} at revision`,
      );
    }
    const clients: ClientCodes[] = [];
    for (const client of context.config.clients) {
      const outcome = await readClient(context, client);
      if (!outcome.ok) {
        errors.push(`client "${client.name}": ${outcome.error}`);
        continue;
      }
      clients.push(outcome.value.codes);
      notes.push(...outcome.value.notes);
    }
    // Without every code source, an absent code could read as removed or added; report nothing then.
    const classified = canCompare ? classifyErrorCodes({ base, revision, clients }) : [];
    const scoped = scopeErrorCodes(classified, {
      returnedBy: context.config.returnedBy ?? [],
      clients: context.config.clients,
      calls: context.calls,
      results: context.results,
    });
    const accepted = applyErrorCodeAccept(scoped.findings, context.config.accept ?? []);
    // With no comparison every entry would read as unused, which is not true.
    if (canCompare) notes.push(...scoped.notes, ...accepted.notes);
    if (errors.length > 0) {
      return {
        layer: ERROR_CODES_LAYER,
        status: "failed",
        error: errors.join("; "),
        findings: accepted.findings,
        notes,
      } satisfies LayerResult;
    }
    return {
      layer: ERROR_CODES_LAYER,
      status: "ran",
      findings: accepted.findings,
      notes,
    } satisfies LayerResult;
  },
});

function addFirst(target: Map<string, CodeDeclaration>, from: ReadonlyMap<string, CodeDeclaration>): void {
  for (const [code, declaration] of from) if (!target.has(code)) target.set(code, declaration);
}

/** Reads every file of `globs` at `tree` with `regex`; a file without a match is listed with no codes. */
async function readFiles(tree: RefTree, globs: string[], regex: RegExp): Promise<Result<FileCodes[]>> {
  const files = await tree.listFiles(globs);
  if (!files.ok) return files;
  const read: FileCodes[] = [];
  for (const path of files.value) {
    const text = await tree.readFile(path);
    if (!text.ok) return err(`cannot read ${path} at ${tree.ref}: ${text.error}`);
    read.push({ path, codes: readCodes(text.value ?? "", regex) });
  }
  return ok(read);
}

function toDeclarations(tree: RefTree, source: string, files: FileCodes[]): Map<string, CodeDeclaration> {
  const declarations = new Map<string, CodeDeclaration>();
  for (const { path, codes } of files) {
    for (const { code, line } of codes) {
      if (declarations.has(code)) continue;
      declarations.set(code, {
        source,
        evidence: { side: tree.side, ref: tree.ref, commit: tree.commit, path, line },
      });
    }
  }
  return declarations;
}

function getRegex(entry: { pattern: string; flags: string }): RegExp {
  const regex = compileCodePattern(entry.pattern, entry.flags);
  // The config schema already rejected a pattern that does not compile.
  if (!(regex instanceof RegExp)) throw new Error(`pattern ${entry.pattern} ${regex.error}`);
  return regex;
}

async function readSource(
  context: LayerContext<ErrorCodesConfig>,
  source: RegexCodeSource,
): Promise<Result<CodeSides>> {
  const regex = getRegex(source);
  const [before, after] = await Promise.all([
    readFiles(context.base, source.files, regex),
    readFiles(context.revision, source.files, regex),
  ]);
  if (!before.ok) return before;
  if (!after.ok) return after;
  const { revision } = context;
  if (after.value.length === 0)
    return err(`no file matches ${source.files.join(", ")} at revision ${revision.ref}`);
  const declarations = toDeclarations(revision, source.name, after.value);
  // A part may capture nothing at a ref; the composed source checks the codes it builds.
  if (declarations.size === 0 && source.report) {
    return err(`pattern captured no code in ${after.value.length} file(s) at revision ${revision.ref}`);
  }
  return ok({ base: toDeclarations(context.base, source.name, before.value), revision: declarations });
}

/** Builds the codes of a composed source at both refs from what its part sources captured. */
function composeSource(
  context: LayerContext<ErrorCodesConfig>,
  source: ComposedCodeSource,
  found: Record<"base" | "revision", ReadonlyMap<string, CodeSet>>,
): Result<CodeSides> {
  const failed = Object.values(source.parts).find((part) => !found.revision.has(part));
  if (failed !== undefined) return err(`skipped because part source "${failed}" failed`);
  const base = composeCodes(source, found.base);
  if (!base.ok) return err(`at ${context.base.ref} ${base.error}`);
  const revision = composeCodes(source, found.revision);
  if (!revision.ok) return err(`at ${context.revision.ref} ${revision.error}`);
  if (revision.value.size === 0) return err(`builds no code at revision ${context.revision.ref}`);
  return ok({ base: base.value, revision: revision.value });
}

async function readClient(
  context: LayerContext<ErrorCodesConfig>,
  client: ErrorCodeClient,
): Promise<Result<{ codes: ClientCodes; notes: string[] }>> {
  const regex = getRegex(client);
  const refs = await resolveRefList(client.refs, {
    repoDir: context.repoDir,
    env: context.env,
    fetch: context.fetch,
  });
  if (!refs.ok) return refs;
  const read: ClientRefCodes[] = [];
  for (const { ref, commit, resolver } of refs.value) {
    const tree = await openRefTree({
      repoDir: context.repoDir,
      ref: commit ?? ref,
      label: ref,
      side: "base",
      tempRoot: context.tempDir,
    });
    if (!tree.ok) {
      const cause =
        resolver === undefined
          ? tree.error
          : `${resolver} resolved to ${ref} (${commit ?? ref}), which is not in the local clone`;
      return err(`${cause}; fetch the client refs (actions/checkout with fetch-depth: 0)`);
    }
    const files = await readFiles(tree.value, client.files, regex);
    if (!files.ok) return err(`${ref}: ${files.error}`);
    if (files.value.length === 0) return err(`${ref}: no file matches ${client.files.join(", ")}`);
    const codes = new Set(files.value.flatMap((file) => file.codes.map(({ code }) => code)));
    // No key at all means a wrong pattern or file: every new code would read as untranslated.
    if (codes.size === 0) {
      return err(`${ref}: pattern captured no code in ${files.value.map(({ path }) => path).join(", ")}`);
    }
    read.push({ ref, commit: tree.value.commit, paths: files.value.map(({ path }) => path), codes });
  }
  const counts = read.map(({ codes }) => codes.size).join("/");
  const notes = [
    `client "${client.name}" at ${read.map(({ ref }) => ref).join(", ")}: ${counts} translated code(s)`,
    ...formatResolvers(client.name, refs.value),
  ];
  return ok({ codes: { client: client.name, refs: read }, notes });
}
