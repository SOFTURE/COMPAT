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
 * entry as its override; the service must exist in one of `composeFiles` in the revision.
 */
export async function scanAppsettingsSource(
  source: AppsettingsSource,
  tree: RefTree,
  { identify, composeFiles }: { identify: KeyIdentity; composeFiles: string[] },
): Promise<Result<SourceScan>> {
  const files = await tree.listFiles(source.files);
  if (!files.ok) return err(`cannot list files at ${tree.ref}: ${files.error}`);
  const read = await readOverrides(source, tree, { identify, composeFiles });
  if (!read.ok) return read;
  const { overrides, serviceFiles } = read.value;
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
          declaration.default === null ? overrides.get(identify(key.replaceAll(":", "__"))) : undefined;
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
  return ok({ index, files: files.value, notes: describeServiceFiles(source, serviceFiles) });
}

/**
 * Several compose files with the service are merged, the first in listing order winning per key.
 * That is right for a deploy split into overlays, wrong when one of them is a local-dev compose,
 * so the merge is never silent.
 */
function describeServiceFiles(source: AppsettingsSource, serviceFiles: string[]): string[] {
  if (serviceFiles.length < 2) return [];
  return [
    `compose service "${source.service}" is in ${serviceFiles.length} files (${serviceFiles.join(", ")}); ` +
      "a key any of them sets counts as set, so list only the deploy files in `composeFiles` if one is not",
  ];
}

/** `src/Api/appsettings.json` with `Production` gives `src/Api/appsettings.Production.json`. */
function getEnvironmentPath(path: string, environment: string): string {
  const name = posix.basename(path).replace(/\.json$/i, "");
  return posix.join(posix.dirname(path), `${name}.${environment}.json`);
}

type ServiceOverrides = { overrides: Map<string, ServiceOverride>; serviceFiles: string[] };

/**
 * The keys the source's compose service sets, by key identity (`Stripe__SecretKey` as
 * `Stripe:SecretKey`), and the compose files that define the service.
 */
async function readOverrides(
  source: AppsettingsSource,
  tree: RefTree,
  { identify, composeFiles }: { identify: KeyIdentity; composeFiles: string[] },
): Promise<Result<ServiceOverrides>> {
  const overrides = new Map<string, ServiceOverride>();
  const serviceFiles: string[] = [];
  const service = source.service;
  if (service === undefined) return ok({ overrides, serviceFiles });
  const files = await tree.listFiles(composeFiles);
  if (!files.ok) return err(`cannot list compose files at ${tree.ref}: ${files.error}`);
  for (const path of files.value) {
    const content = await tree.readFile(path);
    if (!content.ok) return content;
    if (content.value === null) continue;
    const variables = readServiceEnvironment(content.value, service);
    if (variables === null) continue;
    serviceFiles.push(path);
    for (const variable of variables) {
      const id = identify(variable.key.replaceAll(":", "__"));
      if (!overrides.has(id)) overrides.set(id, { service, path, line: variable.line });
    }
  }
  if (serviceFiles.length === 0 && tree.side === "revision") {
    const globs = composeFiles.map((glob) => `"${glob}"`).join(", ");
    return err(`compose service "${service}" is not in any file matching ${globs} in the revision`);
  }
  return ok({ overrides, serviceFiles });
}
