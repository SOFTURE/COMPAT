export const ECOSYSTEMS = ["nuget", "npm"] as const;

export type Ecosystem = (typeof ECOSYSTEMS)[number];

/**
 * One package version a file declares at one ref. `unresolved` says why a version still holds an
 * MSBuild `$(Property)`.
 */
export type Declaration = {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  path: string;
  line: number;
  unresolved?: string;
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
