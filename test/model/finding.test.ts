import { describe, expect, it } from "vitest";
import { compareClass, FINDING_CLASSES, isFindingClass } from "../../src/model/finding.js";

describe("finding classes", () => {
  it("orders classes from safe to breaking", () => {
    expect(FINDING_CLASSES).toEqual(["safe", "needs-action", "rollback-risk", "breaking"]);
    expect(compareClass("breaking", "rollback-risk")).toBeGreaterThan(0);
    expect(compareClass("safe", "needs-action")).toBeLessThan(0);
    expect(compareClass("needs-action", "needs-action")).toBe(0);
  });

  it("recognises only known class names", () => {
    expect(isFindingClass("rollback-risk")).toBe(true);
    expect(isFindingClass("info")).toBe(false);
  });
});
