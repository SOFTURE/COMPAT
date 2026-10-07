// A black-box test suite for server.mjs that writes JUnit XML to results/junit.xml.
// FLAKY_MARKER: the "flaky" test fails until this file exists, then creates it on its first run.
// BROKEN_TEST=1: adds a test that always fails, like one already red at the base.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const baseUrl = `http://127.0.0.1:${process.env.COMPAT_PORT}`;
const tests = [
  {
    name: "returns the pet count",
    run: async () => {
      const body = await (await fetch(`${baseUrl}/pets/count`)).json();
      if (body.count !== 3) throw new Error(`expected count 3, got ${JSON.stringify(body)}`);
    },
  },
  {
    name: "answers the health check",
    run: async () => {
      const response = await fetch(`${baseUrl}/hc`);
      if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
    },
  },
];
if (process.env.FLAKY_MARKER) {
  tests.push({
    name: "is flaky on the first run",
    run: async () => {
      if (existsSync(process.env.FLAKY_MARKER)) return;
      writeFileSync(process.env.FLAKY_MARKER, "1");
      throw new Error("cold start");
    },
  });
}
if (process.env.BROKEN_TEST === "1") {
  tests.push({
    name: "was already broken",
    run: async () => {
      throw new Error("always fails");
    },
  });
}

const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const cases = [];
let failures = 0;
for (const test of tests) {
  try {
    await test.run();
    cases.push(`<testcase classname="Pets.Api.Tests" name="${escapeXml(test.name)}"/>`);
  } catch (error) {
    failures += 1;
    cases.push(
      `<testcase classname="Pets.Api.Tests" name="${escapeXml(test.name)}"><failure message="${escapeXml(error.message)}">${escapeXml(String(error.stack))}</failure></testcase>`,
    );
  }
}
mkdirSync("results", { recursive: true });
writeFileSync(
  "results/junit.xml",
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="Pets.Api.Tests" tests="${tests.length}" failures="${failures}">${cases.join("")}</testsuite></testsuites>\n`,
);
process.exit(failures > 0 ? 1 : 0);
