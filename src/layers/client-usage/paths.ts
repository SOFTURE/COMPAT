export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * `/api/pets/${petId}/x?a=1` and `/api/Pets/{PetId}/x/` both become `/api/pets/{}/x`: no query,
 * no trailing slash, parameters as `{}`, literal segments lower-cased (ASP.NET routes ignore case).
 */
export function normalizePath(path: string): string {
  const withoutQuery = path.split("?")[0] as string;
  const segments = withoutQuery
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) =>
      /[{}$]/.test(segment) ? segment.replace(/\$?\{[^}]*\}/g, "{}") : segment.toLowerCase(),
    );
  return `/${segments.join("/")}`;
}

/** `POST /api/pets/{petId}` → `{ method: "post", path: "/api/pets/{}" }`, or `undefined` for other subjects. */
export function parseOperation(subject: string): { method: HttpMethod; path: string } | undefined {
  const match = /^([A-Z]+) (\/\S*)$/.exec(subject);
  if (!match) return undefined;
  const method = (match[1] as string).toLowerCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) return undefined;
  return { method: method as HttpMethod, path: normalizePath(match[2] as string) };
}

/**
 * Whether a client path can be the spec path: equal, or one ends with the other, so a client that
 * prefixes its paths differently from the spec (`/pets` against `/api/pets`) still counts as calling.
 */
export function isSamePath(clientPath: string, specPath: string): boolean {
  if (clientPath === specPath) return true;
  const [shorter, longer] =
    clientPath.length < specPath.length ? [clientPath, specPath] : [specPath, clientPath];
  const hasLiteral = shorter.split("/").some((segment) => segment !== "" && segment !== "{}");
  return hasLiteral && longer.endsWith(shorter);
}
