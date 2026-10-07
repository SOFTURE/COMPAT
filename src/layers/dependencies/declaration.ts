export const ECOSYSTEMS = ["nuget", "npm"] as const;

export type Ecosystem = (typeof ECOSYSTEMS)[number];

/**
 * How a lockfile resolved a version: `lockfile` for a direct dependency, `transitive` for a watched package
 * installed only as a dependency of another one.
 */
export type Resolution = "lockfile" | "transitive";

/**
 * One package version a file declares or a lockfile resolves at one ref; `resolution` is absent for a
 * manifest. `unresolved` says why a version still holds an MSBuild `$(Property)`.
 */
export type Declaration = {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  path: string;
  line: number;
  unresolved?: string;
  resolution?: Resolution;
};

/** NuGet package ids are case-insensitive; npm names are compared as written. */
export function getPackageKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}:${ecosystem === "nuget" ? name.toLowerCase() : name}`;
}

export function getLineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) if (text.charCodeAt(index) === 10) line++;
  return line;
}

/** Maps offsets to 1-based line numbers of one text; built once so a large lockfile is not rescanned per entry. */
export function createLineLocator(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] as number) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}
