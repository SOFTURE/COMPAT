import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BEHAVIOUR_FINDING_IDS } from "../src/layers/behaviour/config.js";
import { CONFIG_FINDING_IDS } from "../src/layers/config/classify.js";
import { DEPENDENCY_FINDING_IDS } from "../src/layers/dependencies/config.js";
import { ERROR_CODE_FINDING_CLASSES } from "../src/layers/error-codes/config.js";
import { MESSAGE_CONTRACT_FINDING_IDS } from "../src/layers/message-contracts/config.js";
import { OUTBOUND_FINDING_CLASSES } from "../src/layers/outbound/config.js";
import { ENUM_CHANGE_IDS } from "../src/layers/persisted-enums/config.js";
import { LAYERS } from "../src/layers/registry.js";
import { SEED_RULE_CLASSES } from "../src/layers/seed/classify.js";
import { RULE_CLASSES } from "../src/layers/sql-migrations/rules.js";
import { USAGE } from "../src/main.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** The README section of one layer: from its `### <name>` heading to the next heading of that level or higher. */
function getSection(name: string): string {
  const start = readme.indexOf(`\n### ${name}\n`);
  if (start === -1) return "";
  const rest = readme.slice(start + 1);
  const end = rest.slice(1).search(/\n#{1,3} /);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

/** The table row that lists the ids of one class: `| <class> | <ids> |`. */
function getClassRow(section: string, findingClass: string): string {
  return section.split("\n").find((line) => line.startsWith(`| \`${findingClass}\` |`)) ?? "";
}

describe("README reference", () => {
  it.each(LAYERS.map((layer) => layer.name))("has a section for the %s layer", (name) => {
    expect(getSection(name)).not.toBe("");
  });

  it("lists every sql-migrations rule under its class", () => {
    const section = getSection("sql-migrations");
    for (const [id, findingClass] of Object.entries(RULE_CLASSES)) {
      expect(getClassRow(section, findingClass), id).toContain(`\`${id}\``);
    }
    for (const id of ["migration-modified", "migration-removed"]) {
      expect(getClassRow(section, "needs-action"), id).toContain(`\`${id}\``);
    }
  });

  it("lists every seed finding under its class", () => {
    const section = getSection("seed");
    for (const [id, findingClass] of Object.entries(SEED_RULE_CLASSES)) {
      expect(getClassRow(section, findingClass), id).toContain(`\`${id}\``);
    }
  });

  it("lists every persisted-enums and config finding id", () => {
    for (const id of ENUM_CHANGE_IDS) expect(getSection("persisted-enums"), id).toContain(`| \`${id}\` |`);
    for (const id of CONFIG_FINDING_IDS) expect(getSection("config"), id).toContain(`| \`${id}\` |`);
  });

  it("lists every message-contracts finding id", () => {
    for (const id of MESSAGE_CONTRACT_FINDING_IDS)
      expect(getSection("message-contracts"), id).toContain(`\`${id}\``);
  });

  it("lists every behaviour finding id", () => {
    for (const id of BEHAVIOUR_FINDING_IDS) expect(getSection("behaviour"), id).toContain(`| \`${id}\` |`);
  });

  it("lists every error-codes finding under its class", () => {
    const section = getSection("error-codes");
    for (const [id, findingClass] of Object.entries(ERROR_CODE_FINDING_CLASSES)) {
      expect(getClassRow(section, findingClass), id).toContain(`\`${id}\``);
    }
  });

  it("lists every outbound finding under its class", () => {
    const section = getSection("outbound");
    for (const [id, findingClass] of Object.entries(OUTBOUND_FINDING_CLASSES)) {
      expect(getClassRow(section, findingClass), id).toContain(`\`${id}\``);
    }
  });

  it("lists every dependencies finding id", () => {
    for (const id of DEPENDENCY_FINDING_IDS)
      expect(getSection("dependencies"), id).toContain(`| \`${id}\` |`);
  });

  it("documents every command-line flag", () => {
    const flags = [...USAGE.matchAll(/^\s+(?:-\w, )?(--[\w-]+)/gm)].map((match) => match[1]);
    expect(flags.length).toBeGreaterThan(5);
    for (const flag of flags) expect(readme, flag).toContain(`\`${flag}`);
  });

  it("says where `command` spec sources run and how to install oasdiff", () => {
    expect(getSection("openapi")).toContain("the command runs twice");
    expect(getSection("openapi")).toContain("COMPAT_SIDE");
    expect(readme).toContain("go install github.com/oasdiff/oasdiff@v1.33.0");
  });

  it("lists every input of the GitHub Action", () => {
    const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
    const inputsBlock = action.slice(action.indexOf("\ninputs:\n"), action.indexOf("\noutputs:\n"));
    const inputs = [...inputsBlock.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]);
    expect(inputs).toContain("base");
    for (const input of inputs) expect(getSection("In CI"), input).toContain(`| \`${input}\` |`);
  });
});
