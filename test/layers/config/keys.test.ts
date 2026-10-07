import { describe, expect, it } from "vitest";
import { getKeyIdentity, normalizeKey, splitKeyWords } from "../../../src/layers/config/keys.js";

describe("normalizeKey", () => {
  it("gives one canonical key for the spellings of one setting", () => {
    const spellings = [
      "Shop:BaseUrl",
      "Shop__BaseUrl",
      "SHOP_BASE_URL",
      "shop.base_url",
      "shop-base-url",
      "ShopBaseUrl",
    ];
    expect(new Set(spellings.map(normalizeKey))).toEqual(new Set(["SHOP_BASE_URL"]));
  });

  it("keeps acronyms and digits inside their word", () => {
    expect(splitKeyWords("APIKey")).toEqual(["api", "key"]);
    expect(splitKeyWords("S3Bucket")).toEqual(["s3", "bucket"]);
    expect(splitKeyWords("Http2Enabled")).toEqual(["http2", "enabled"]);
    expect(splitKeyWords("OAUTH2_CLIENT_ID")).toEqual(["oauth2", "client", "id"]);
    expect(splitKeyWords("ÀbcKey")).toEqual(["àbc", "key"]);
  });

  it("keeps different settings apart", () => {
    expect(normalizeKey("Shop__BaseUrl")).not.toBe(normalizeKey("Payment__BaseUrl"));
    expect(normalizeKey("BaseUrl")).not.toBe(normalizeKey("Shop__BaseUrl"));
  });

  it("keeps a key without letters or digits as written", () => {
    expect(normalizeKey("__")).toBe("__");
  });
});

describe("getKeyIdentity", () => {
  it("normalizes in normalized mode and keeps the spelling in exact mode", () => {
    expect(getKeyIdentity("normalized")("Shop:BaseUrl")).toBe("SHOP_BASE_URL");
    expect(getKeyIdentity("exact")("Shop:BaseUrl")).toBe("Shop:BaseUrl");
  });
});
