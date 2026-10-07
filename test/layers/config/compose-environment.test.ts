// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { describe, expect, it } from "vitest";
import { findPassThroughKeys } from "../../../src/layers/config/compose-environment.js";
import { maskYamlComments } from "../../../src/layers/config/yaml-text.js";

function find(lines: string[]): { key: string; line: number; default: string | null }[] {
  return findPassThroughKeys(maskYamlComments(lines.join("\n")));
}

function required(key: string, line: number): { key: string; line: number; default: null } {
  return { key, line, default: null };
}

describe("findPassThroughKeys", () => {
  it("reads sequence items without a value", () => {
    const lines = [
      "services:",
      "  app:",
      "    environment:",
      "      - API_KEY",
      '      - "QUOTED"',
      "      - SET=1",
      "      - FROM=${ELSEWHERE}",
      "      - ${INTERPOLATED}",
      "      - LAST # comment",
      "    image: app",
      "    command:",
      "      - NOT_ENV",
    ];
    expect(find(lines)).toEqual([required("API_KEY", 4), required("QUOTED", 5), required("LAST", 9)]);
  });

  it("reads a compact sequence at the key's indent", () => {
    const lines = ["app:", "  environment:", "  - TOKEN", "  - X=1", "  image: app", "  - STRAY"];
    expect(find(lines)).toEqual([required("TOKEN", 3)]);
  });

  it("reads mapping keys with an empty or null value", () => {
    const lines = [
      "x:",
      "  environment:",
      "    EMPTY:",
      "    TILDE: ~",
      "    NULLED: null",
      '    "QUOTED_KEY":',
      "    SET: value",
      '    BLANK_STRING: ""',
      "    BLOCK: |",
      "      FAKE:",
      "    NESTED:",
      "      deeper: 1",
      "  ports: []",
    ];
    expect(find(lines)).toEqual([
      required("EMPTY", 3),
      required("TILDE", 4),
      required("NULLED", 5),
      required("QUOTED_KEY", 6),
    ]);
  });

  it("reads flow sequences and mappings, also across lines", () => {
    const lines = [
      "a:",
      "  environment: [ONE, \"TWO\", THREE=3, 'FOUR']",
      "b:",
      "  environment: [",
      "    FIVE, # comment",
      "    SIX=6,",
      "    SEVEN",
      "  ]",
      "c:",
      "  environment: {EIGHT: , NINE: 9, TEN, ELEVEN: ~}",
    ];
    expect(find(lines)).toEqual([
      required("ONE", 2),
      required("TWO", 2),
      required("FOUR", 2),
      required("FIVE", 5),
      required("SEVEN", 7),
      required("EIGHT", 10),
      required("TEN", 10),
      required("ELEVEN", 10),
    ]);
  });

  it("resolves aliases and merge keys to the anchored node", () => {
    const lines = [
      "x-env: &shared",
      "  SHARED_KEY:",
      "  SET: 1",
      "x-list: &list [LISTED]",
      "x-more: &more",
      "  - MORE_KEY",
      "services:",
      "  a:",
      "    environment: *list",
      "  b:",
      "    environment:",
      "      <<: [*shared]",
      "      OWN:",
      "  c:",
      "    environment: *more",
    ];
    expect(find(lines)).toEqual([
      required("LISTED", 4),
      required("SHARED_KEY", 2),
      required("OWN", 13),
      required("MORE_KEY", 6),
    ]);
  });

  it("stops on alias cycles and ignores unknown aliases", () => {
    const lines = [
      "a: &one",
      "  environment: *two",
      "b: &two",
      "  environment: *one",
      "c:",
      "  environment: *none",
    ];
    expect(find(lines)).toEqual([]);
  });

  it("ignores environment keys inside block scalars and comments", () => {
    const lines = ["script: |", "  environment:", "    - HIDDEN", "# environment:", "#   - COMMENTED"];
    expect(find(lines)).toEqual([]);
  });

  it("returns nothing for an empty environment", () => {
    expect(find(["app:", "  environment:", "  image: x"])).toEqual([]);
  });
});
