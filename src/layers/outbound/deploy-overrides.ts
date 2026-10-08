import type { RefTree } from "../../git/ref-tree.js";
import type { Evidence } from "../../model/finding.js";
import { err, ok, type Result } from "../../result.js";
import { readServiceEnvironment } from "../config/compose-services.js";
import type { SettingLeaf } from "../config/scan-appsettings.js";
import { normalizeTarget } from "./read-targets.js";

/** Where the deploy sets the key a target was read from: the compose entry and the variables its value interpolates. */
export type DeployOverride = {
  /** The key as the compose file writes it, e.g. `Shop__BaseUrl`. */
  key: string;
  service: string;
  /** `SHOP_BASE_URL` for `Shop__BaseUrl=${SHOP_BASE_URL}`; empty for a literal or pass-through value. */
  variables: string[];
  evidence: Evidence;
};

/**
 * The identity .NET configuration gives a key: case-insensitive, with `__` read as `:`, so the compose
 * entry `Shop__BaseUrl` overrides the appsettings path `Shop:BaseUrl`.
 */
export function getDeployKeyId(key: string): string {
  return key.replaceAll("__", ":").toLowerCase();
}

/** The variables a compose value interpolates, in order: `${A}`, `${A:-x}` and `$A`; `$$` is a literal `$`. */
export function getInterpolatedVariables(value: string | null): string[] {
  if (value === null) return [];
  const names = [...value.matchAll(/\$\$|\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  return [...new Set(names)];
}

/**
 * The keys the compose `service` sets in `composeFiles` at one ref, by `getDeployKeyId`; the first file in listing
 * order wins per key. The service must exist in the revision, since a misnamed service would hide every override.
 */
export async function readDeployOverrides(
  tree: RefTree,
  { service, composeFiles }: { service: string; composeFiles: string[] },
): Promise<Result<Map<string, DeployOverride>>> {
  const overrides = new Map<string, DeployOverride>();
  const files = await tree.listFiles(composeFiles);
  if (!files.ok) return err(`cannot list compose files at ${tree.ref}: ${files.error}`);
  let isServiceFound = false;
  for (const path of files.value) {
    const content = await tree.readFile(path);
    if (!content.ok) return err(`cannot read ${path} at ${tree.ref}: ${content.error}`);
    if (content.value === null) continue;
    const variables = readServiceEnvironment(content.value, service);
    if (variables === null) continue;
    isServiceFound = true;
    for (const variable of variables) {
      const id = getDeployKeyId(variable.key);
      if (overrides.has(id)) continue;
      overrides.set(id, {
        key: variable.key,
        service,
        variables: getInterpolatedVariables(variable.value),
        evidence: { side: tree.side, ref: tree.ref, commit: tree.commit, path, line: variable.line },
      });
    }
  }
  if (!isServiceFound && tree.side === "revision") {
    const globs = composeFiles.map((glob) => `"${glob}"`).join(", ");
    return err(`compose service "${service}" is not in any file matching ${globs} in the revision`);
  }
  return ok(overrides);
}

/**
 * The configuration path of the appsettings leaf a capture on `line` belongs to. With several leaves on the line,
 * the one whose value is the captured target or its base wins; `undefined` when no leaf starts on the line.
 */
export function findLeafKey(
  leaves: readonly SettingLeaf[],
  line: number,
  target: string,
): string | undefined {
  const candidates = leaves.filter((leaf) => leaf.line === line);
  const matching = candidates.find((leaf) => {
    if (leaf.value === null) return false;
    const value = normalizeTarget(leaf.value);
    return value.ok && value.value !== "" && (target === value.value || target.startsWith(`${value.value}/`));
  });
  return (matching ?? candidates[0])?.key;
}
