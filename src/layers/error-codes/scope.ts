import { globToRegExp, matchesGlob } from "../../git/glob.js";
import type { Finding, LayerResult } from "../../model/finding.js";
import { isSamePath, parseOperation } from "../client-usage/paths.js";
import { formatRefs } from "../client-usage/refine.js";
import type { ClientRefCalls } from "../layer.js";
import { OPENAPI_LAYER } from "../openapi/classify.js";
import { ERROR_CODES_LAYER, type ReturnedBy } from "./config.js";

type Operation = { method: string; path: string };

export type ScopeErrorCodesOptions = {
  returnedBy: readonly ReturnedBy[];
  clients: readonly { name: string; usage?: string[] }[];
  /** What live client refs call; `undefined` when `client-usage` did not run. */
  calls: readonly ClientRefCalls[] | undefined;
  /** Results of the earlier layers; the `endpoint-added` findings of `openapi` mark operations new in the revision. */
  results: readonly LayerResult[] | undefined;
};

/** Operations `openapi` reports as `endpoint-added`, by API. */
function getAddedOperations(results: readonly LayerResult[] | undefined): Map<string, Operation[]> {
  const added = new Map<string, Operation[]>();
  for (const result of results ?? []) {
    if (result.layer !== OPENAPI_LAYER || result.status === "skipped") continue;
    for (const finding of result.findings) {
      const operation = finding.id === "endpoint-added" ? parseOperation(finding.subject) : undefined;
      if (operation !== undefined) added.set(finding.scope, [...(added.get(finding.scope) ?? []), operation]);
    }
  }
  return added;
}

/** Whether a called operation matches `METHOD /path/glob`; a call with an unknown method matches every method. */
function matchesOperation(call: Operation, glob: string): boolean {
  const [method, path] = glob.split(" ") as [string, string];
  const isMethod = method === "*" || call.method === "*" || call.method === method.toLowerCase();
  // Client paths are lower-cased, and ASP.NET routes ignore case.
  return isMethod && new RegExp(globToRegExp(path).source, "i").test(call.path);
}

/**
 * Re-classifies `error-code-unknown-to-client` findings by the operations that return the code: when
 * every `returnedBy` entry matching the code names operations that the client's live refs either do not
 * call or call only as endpoints new in the revision, the finding becomes `safe`. A code no entry covers,
 * or a client without `client-usage` calls, keeps its finding (fail closed).
 */
export function scopeErrorCodes(
  findings: Finding[],
  options: ScopeErrorCodesOptions,
): { findings: Finding[]; notes: string[] } {
  if (options.returnedBy.length === 0) return { findings, notes: [] };
  const added = getAddedOperations(options.results);
  const unscoped = new Set<string>();
  let toSafe = 0;
  const scoped = findings.map((finding) => {
    if (finding.id !== "error-code-unknown-to-client") return finding;
    const entries = options.returnedBy.filter((entry) =>
      entry.codes.some((glob) => matchesGlob(finding.subject, glob)),
    );
    if (entries.length === 0) return finding;
    const client = options.clients.find(({ name }) => name === finding.scope);
    const names = client?.usage ?? [finding.scope];
    const refs = (options.calls ?? []).filter((calls) => names.includes(calls.client));
    if (refs.length === 0) {
      unscoped.add(finding.scope);
      return finding;
    }
    const reached = new Set<string>();
    const callers: ClientRefCalls[] = [];
    let callsNew = false;
    for (const entry of entries) {
      for (const ref of refs.filter(({ api }) => api === entry.api)) {
        for (const call of ref.operations) {
          if (!entry.operations.some((glob) => matchesOperation(call, glob))) continue;
          const isNew = (added.get(entry.api) ?? []).some(
            (operation) => operation.method === call.method && isSamePath(call.path, operation.path),
          );
          if (isNew) {
            callsNew = true;
            continue;
          }
          reached.add(`${call.method.toUpperCase()} ${call.path}`);
          if (!callers.includes(ref)) callers.push(ref);
        }
      }
    }
    if (reached.size > 0) {
      return {
        ...finding,
        message: `${finding.message}; returned by ${[...reached].join(", ")}, which ${formatRefs(callers)} calls`,
      };
    }
    toSafe++;
    const returners = entries.map((entry) => `${entry.operations.join(", ")} (${entry.api})`).join("; ");
    const reason = callsNew
      ? `returned only by ${returners}; ${formatRefs(refs)} calls there only endpoints new in the revision`
      : `returned only by ${returners}, which ${formatRefs(refs)} does not call`;
    return {
      ...finding,
      class: "safe" as const,
      reclassified: { from: finding.class, by: ERROR_CODES_LAYER, reason },
    };
  });
  const notes = [...unscoped].map(
    (name) =>
      `client "${name}": no client-usage calls, so returnedBy cannot scope its codes; enable client-usage with a client named "${name}" or list its clients in clients[].usage`,
  );
  notes.push(`returnedBy made ${toSafe} error-code-unknown-to-client finding(s) safe`);
  return { findings: scoped, notes };
}
