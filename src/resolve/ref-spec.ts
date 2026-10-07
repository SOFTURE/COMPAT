/** What `--base` or `--revision` asks for: a git ref as written, or a resolver that finds one. */
export type RefSpec =
  | { kind: "literal"; ref: string }
  | { kind: "github-deployment"; environment: string }
  | { kind: "github-workflow"; workflow: string }
  | { kind: "latest-tag"; glob?: string };

export const GITHUB_DEPLOYMENT_PREFIX = "github-deployment:";
export const GITHUB_WORKFLOW_PREFIX = "github-workflow:";
export const LATEST_TAG = "latest-tag";

/**
 * Reads a `--base` or `--revision` value. A git ref cannot contain `:`, so the prefixed forms never
 * shadow a real ref; only a branch literally named `latest-tag` is taken as the resolver.
 */
export function parseRefSpec(value: string): RefSpec {
  if (value.startsWith(GITHUB_DEPLOYMENT_PREFIX)) {
    return { kind: "github-deployment", environment: value.slice(GITHUB_DEPLOYMENT_PREFIX.length) };
  }
  if (value.startsWith(GITHUB_WORKFLOW_PREFIX)) {
    return { kind: "github-workflow", workflow: value.slice(GITHUB_WORKFLOW_PREFIX.length) };
  }
  if (value === LATEST_TAG) return { kind: "latest-tag" };
  if (value.startsWith(`${LATEST_TAG}:`))
    return { kind: "latest-tag", glob: value.slice(LATEST_TAG.length + 1) };
  return { kind: "literal", ref: value };
}

export function formatRefSpec(spec: RefSpec): string {
  switch (spec.kind) {
    case "literal":
      return spec.ref;
    case "github-deployment":
      return `${GITHUB_DEPLOYMENT_PREFIX}${spec.environment}`;
    case "github-workflow":
      return `${GITHUB_WORKFLOW_PREFIX}${spec.workflow}`;
    case "latest-tag":
      return spec.glob === undefined ? LATEST_TAG : `${LATEST_TAG}:${spec.glob}`;
  }
}
