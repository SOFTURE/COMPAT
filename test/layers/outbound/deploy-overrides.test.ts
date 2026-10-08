// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { describe, expect, it } from "vitest";
import { readSettingLeaves } from "../../../src/layers/config/scan-appsettings.js";
import {
  findLeafKey,
  getDeployKeyId,
  getInterpolatedVariables,
} from "../../../src/layers/outbound/deploy-overrides.js";

describe("getDeployKeyId", () => {
  it("reads __ as : and ignores case, as .NET configuration does", () => {
    expect(getDeployKeyId("Shop__BaseUrl")).toBe("shop:baseurl");
    expect(getDeployKeyId("Shop:BaseUrl")).toBe("shop:baseurl");
    expect(getDeployKeyId("SHOP_BASE_URL")).toBe("shop_base_url");
  });
});

describe("getInterpolatedVariables", () => {
  it("lists braced, defaulted and bare variables once each and skips $$", () => {
    expect(getInterpolatedVariables("${SHOP_BASE_URL}")).toEqual(["SHOP_BASE_URL"]);
    expect(getInterpolatedVariables("https://${HOST:-a.example.com}/$PREFIX/${HOST}")).toEqual([
      "HOST",
      "PREFIX",
    ]);
    expect(getInterpolatedVariables("$$LITERAL")).toEqual([]);
  });

  it("gives no variable for a literal or a pass-through value", () => {
    expect(getInterpolatedVariables("https://api.example.com")).toEqual([]);
    expect(getInterpolatedVariables(null)).toEqual([]);
  });
});

describe("findLeafKey", () => {
  const leaves = readSettingLeaves(
    [
      "{",
      '  "Shop": { "Name": "shop", "BaseUrl": "https://api-shop-dev.example.com/" },',
      '  "Maps": { "BaseUrl": "https://maps.example.com" }',
      "}",
    ].join("\n"),
  );
  if (leaves === null) throw new Error("fixture is not JSON");

  it("picks the leaf on the line whose value is the target or its base", () => {
    expect(findLeafKey(leaves, 2, "api-shop-dev.example.com")).toBe("Shop:BaseUrl");
    expect(findLeafKey(leaves, 3, "maps.example.com/v1/geocode")).toBe("Maps:BaseUrl");
  });

  it("falls back to the first leaf on the line and gives undefined for a line without one", () => {
    expect(findLeafKey(leaves, 2, "other.example.com")).toBe("Shop:Name");
    expect(findLeafKey(leaves, 1, "api-shop-dev.example.com")).toBeUndefined();
  });
});
