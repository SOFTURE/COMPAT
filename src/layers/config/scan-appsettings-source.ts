import { posix } from "node:path";
import type { RefTree } from "../../git/ref-tree.js";
import { err, ok, type Result } from "../../result.js";
import type { KeyIndex, ServiceOverride, SourcedDeclaration } from "./classify.js";
import { readServiceEnvironment } from "./compose-services.js";
import type { ConfigSource } from "./config.js";
import type { SourceScan } from "./config-layer.js";
import type { KeyIdentity } from "./keys.js";
import { readSettingLeaves, toDeclarations } from "./scan-appsettings.js";

type AppsettingsSource = Extract<ConfigSource, { kind: "appsettings" }>;

/**
 * Reads the keys of an `appsettings` source at one ref. With `environment`, the sibling
 * `appsettings.{environment}.json` is layered over each file; its keys are still compared under
 * the base file, so a value moving between the two layers is not a removed and an added key. With
 * `service`, a key without a default that the service's compose `environment` sets carries that
 * entry as its override; the service must exist in a compose file of the revision.
 */
export async function scanAppsettingsSource(
  source: AppsettingsSource,
  tree: RefTree,
  identify: KeyIdentity,
): Promise<Result<SourceScan>> {
  const files = await tree.listFiles(source.files);
  if (!files.ok) return err(`cannot list files at ${tree.ref}: ${files.error}`);
  const overrides = await readOverrides(source, tree, identify);
  if (!overrides.ok) return overrides;
  const placeholder = new RegExp(source.placeholder, "i");
  const index: KeyIndex = new Map();
  for (const path of files.value) {
    const layers = [
      path,
      ...(source.environment === undefined ? [] : [getEnvironmentPath(path, source.environment)]),
    ];
    const effective = new Map<string, SourcedDeclaration>();
    for (const layer of layers) {
      const content = await tree.readFile(layer);
      if (!content.ok) return content;
      if (content.value === null) continue;
      const leaves = readSettingLeaves(content.value);
      if (leaves === null) return err(`${layer} at ${tree.ref} is not valid JSON`);
      for (const declaration of toDeclarations(leaves, placeholder)) {
        const key = `${source.prefix ?? ""}${declaration.key}`;
        const override =
          declaration.default === null ? overrides.value.get(identify(key.replaceAll(":", "__"))) : undefined;
        effective.set(identify(key), {
          ...declaration,
          key,
          source: source.name,
          path: layer,
          unit: path,
          ...(source.service === undefined ? {} : { service: source.service }),
          ...(override === undefined ? {} : { override }),
        });
      }
    }
    for (const [id, declaration] of effective) index.set(id, [...(index.get(id) ?? []), declaration]);
  }
  return ok({ index, files: files.value });
}

/** `src/Api/appsettings.json` with `Production` gives `src/Api/appsettings.Production.json`. */
function getEnvironmentPath(path: string, environment: string): string {
  const name = posix.basename(path).replace(/\.json$/i, "");
  return posix.join(posix.dirname(path), `${name}.${environment}.json`);
}

/** The keys the source's compose service sets, by key identity (`Stripe__SecretKey` as `Stripe:SecretKey`). */
async function readOverrides(
  source: AppsettingsSource,
  tree: RefTree,
  identify: KeyIdentity,
): Promise<Result<Map<string, ServiceOverride>>> {
  const overrides = new Map<string, ServiceOverride>();
  const service = source.service;
  if (service === undefined) return ok(overrides);
  const files = await tree.listFiles(source.composeFiles);
  if (!files.ok) return err(`cannot list compose files at ${tree.ref}: ${files.error}`);
  let isFound = false;
  for (const path of files.value) {
    const content = await tree.readFile(path);
    if (!content.ok) return content;
    if (content.value === null) continue;
    const variables = readServiceEnvironment(content.value, service);
    if (variables === null) continue;
    isFound = true;
    for (const variable of variables) {
      const id = identify(variable.key.replaceAll(":", "__"));
      if (!overrides.has(id)) overrides.set(id, { service, path, line: variable.line });
    }
  }
  if (!isFound && tree.side === "revision") {
    const globs = source.composeFiles.map((glob) => `"${glob}"`).join(", ");
    return err(`compose service "${service}" is not in any file matching ${globs} in the revision`);
  }
  return ok(overrides);
}
