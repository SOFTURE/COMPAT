import { describe, expect, it } from "vitest";
import { formatRefSpec, parseRefSpec } from "../../src/resolve/ref-spec.js";

describe("parseRefSpec", () => {
  it.each([
    ["v2.2.4", { kind: "literal", ref: "v2.2.4" }],
    ["HEAD~1", { kind: "literal", ref: "HEAD~1" }],
    ["github-deployment:prod", { kind: "github-deployment", environment: "prod" }],
    ["github-workflow:deploy-prod.yml", { kind: "github-workflow", workflow: "deploy-prod.yml" }],
    ["latest-tag", { kind: "latest-tag" }],
    ["latest-tag:v2.*", { kind: "latest-tag", glob: "v2.*" }],
    ["latest-tags", { kind: "literal", ref: "latest-tags" }],
  ])("reads %s", (value, spec) => {
    expect(parseRefSpec(value)).toEqual(spec);
  });

  it.each(["v1", "github-deployment:prod", "github-workflow:deploy.yml", "latest-tag", "latest-tag:v*"])(
    "formats %s back to the same text",
    (value) => {
      expect(formatRefSpec(parseRefSpec(value))).toBe(value);
    },
  );
});
