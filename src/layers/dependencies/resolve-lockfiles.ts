import type { RefTree } from "../../git/ref-tree.js";
import { err, ok, type Result } from "../../result.js";
import { type Declaration, type Ecosystem, getPackageKey, type Resolution } from "./declaration.js";
import type { LockedVersion, NpmLockfile } from "./lockfile.js";
import { readNugetLock } from "./read-nuget-lock.js";
import { readPackageLock } from "./read-package-lock.js";
import { readPnpmLock } from "./read-pnpm-lock.js";

/** In one folder `package-lock.json` is tried before `pnpm-lock.yaml`. */
const NPM_LOCKFILES = ["package-lock.json", "pnpm-lock.yaml"] as const;

const NUGET_LOCKFILE = "packages.lock.json";

export type ResolveOptions = {
  tree: RefTree;
  /** The manifests the source matched, and what they declare. */
  files: string[];
  declared: Declaration[];
  isWatched: (name: string) => boolean;
};

/** Versions the lockfiles paired with the manifests resolve, and the lockfiles that were read. */
export type Resolved = { declarations: Declaration[]; lockfiles: string[] };

function getFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

const joinPath = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);

function toDeclaration(
  ecosystem: Ecosystem,
  path: string,
  locked: LockedVersion,
  resolution: Resolution,
): Declaration {
  return { ecosystem, name: locked.name, version: locked.version, path, line: locked.line, resolution };
}

async function readText(tree: RefTree, path: string): Promise<Result<string | null>> {
  const text = await tree.readFile(path);
  return text.ok ? text : err(`cannot read ${path} at ${tree.ref}: ${text.error}`);
}

/**
 * Pairs every `package.json` with the nearest `package-lock.json` or `pnpm-lock.yaml` in its folder or above that
 * installs it (npm and pnpm workspaces keep one lockfile at the root), and resolves its direct dependencies there.
 */
export async function resolveNpm(options: ResolveOptions): Promise<Result<Resolved>> {
  const loaded = new Map<string, NpmLockfile | null>();
  const load = async (path: string): Promise<Result<NpmLockfile | null>> => {
    const cached = loaded.get(path);
    if (cached !== undefined) return ok(cached);
    const text = await readText(options.tree, path);
    if (!text.ok) return text;
    if (text.value === null) {
      loaded.set(path, null);
      return ok(null);
    }
    const read = path.endsWith(".yaml")
      ? readPnpmLock(text.value, path, options.isWatched)
      : readPackageLock(text.value, path, options.isWatched);
    if (!read.ok) return err(`at ${options.tree.ref}: ${read.error}`);
    loaded.set(path, read.value);
    return read;
  };
  const declarations: Declaration[] = [];
  const used = new Set<string>();
  for (const manifest of options.files) {
    const folder = getFolder(manifest);
    const paired = await findNpmLockfile(folder, load);
    if (!paired.ok) return paired;
    if (paired.value === null) continue;
    const { path, lockfile, importer } = paired.value;
    used.add(path);
    for (const declaration of options.declared) {
      if (declaration.path !== manifest) continue;
      const locked = lockfile.resolveDirect(importer, declaration.name);
      if (locked !== undefined) declarations.push(toDeclaration("npm", path, locked, "lockfile"));
    }
  }
  const lockfiles = [...used].sort();
  for (const path of lockfiles) {
    const lockfile = loaded.get(path) as NpmLockfile;
    declarations.push(...lockfile.watched.map((locked) => toDeclaration("npm", path, locked, "transitive")));
  }
  return ok({ declarations, lockfiles });
}

type PairedNpmLockfile = { path: string; lockfile: NpmLockfile; importer: string };

/** Walks up from the manifest folder; the first folder holding a lockfile decides, even when it does not install it. */
async function findNpmLockfile(
  folder: string,
  load: (path: string) => Promise<Result<NpmLockfile | null>>,
): Promise<Result<PairedNpmLockfile | null>> {
  let current = folder;
  for (;;) {
    const importer = current === folder ? "" : folder.slice(current === "" ? 0 : current.length + 1);
    let found = false;
    for (const name of NPM_LOCKFILES) {
      const path = joinPath(current, name);
      const lockfile = await load(path);
      if (!lockfile.ok) return lockfile;
      if (lockfile.value === null) continue;
      found = true;
      if (lockfile.value.hasImporter(importer)) return ok({ path, lockfile: lockfile.value, importer });
    }
    if (found || current === "") return ok(null);
    current = getFolder(current);
  }
}

/** Reads the `packages.lock.json` in the folder of every matched MSBuild file. */
export async function resolveNuget(options: ResolveOptions): Promise<Result<Resolved>> {
  const declarations: Declaration[] = [];
  const lockfiles: string[] = [];
  const paths = [...new Set(options.files.map((file) => joinPath(getFolder(file), NUGET_LOCKFILE)))].sort();
  for (const path of paths) {
    const text = await readText(options.tree, path);
    if (!text.ok) return text;
    if (text.value === null) continue;
    const read = readNugetLock(text.value, path, options.isWatched);
    if (!read.ok) return err(`at ${options.tree.ref}: ${read.error}`);
    lockfiles.push(path);
    declarations.push(...read.value.direct.map((locked) => toDeclaration("nuget", path, locked, "lockfile")));
    declarations.push(
      ...read.value.watched.map((locked) => toDeclaration("nuget", path, locked, "transitive")),
    );
  }
  return ok({ declarations, lockfiles });
}

/**
 * Per package, the resolved versions when a lockfile resolved any, the declared ones otherwise: a range in a
 * manifest says least what runs once a lockfile pins it.
 */
export function preferResolved(declared: Declaration[], resolved: Declaration[]): Declaration[] {
  const resolvedKeys = new Set(
    resolved.map((declaration) => getPackageKey(declaration.ecosystem, declaration.name)),
  );
  return [
    ...declared.filter(
      (declaration) => !resolvedKeys.has(getPackageKey(declaration.ecosystem, declaration.name)),
    ),
    ...resolved,
  ];
}
