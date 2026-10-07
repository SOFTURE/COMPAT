import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findResultFiles,
  parseTestResults,
  removeResultFiles,
  summarizeTests,
  type TestCase,
} from "../../../src/layers/behaviour/test-results.js";

const JUNIT = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="api">
    <testcase classname="Api.PetsTests" name="returns pets"/>
    <testcase classname="Api.PetsTests" name="parses numbers"><failure message="expected 1.5&#10;got 15">stack</failure></testcase>
    <testcase classname="Api.PetsTests" name="crashes"><error>NullReferenceException
   at Api.Pets.Get()
   at x
   at y</error></testcase>
    <testcase name="skipped one"><skipped/></testcase>
  </testsuite>
</testsuites>`;

const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="1" testName="PETSEO.Integration.Tests.PetsTests.Returns_count" outcome="Passed"/>
    <UnitTestResult testId="2" testName="Parses_query" outcome="Failed">
      <Output><ErrorInfo><Message>Assert.Equal() Failure
Expected: 1.5
Actual:   15</Message><StackTrace>at x</StackTrace></ErrorInfo></Output>
      <InnerResults><UnitTestResult testId="3" testName="row" outcome="Failed"/></InnerResults>
    </UnitTestResult>
    <UnitTestResult testId="4" testName="Times_out" outcome="Timeout"/>
    <UnitTestResult testId="5" testName="Not_run" outcome="NotExecuted"/>
  </Results>
  <TestDefinitions>
    <UnitTest id="1"><TestMethod className="PETSEO.Integration.Tests.PetsTests" name="Returns_count"/></UnitTest>
    <UnitTest id="2"><TestMethod className="Api.QueryTests, Api.Tests, Version=1.0.0.0" name="Parses_query"/></UnitTest>
  </TestDefinitions>
</TestRun>`;

describe("parseTestResults", () => {
  it("reads JUnit XML test cases with failures, errors and skips", () => {
    expect(parseTestResults("junit", JUNIT, "out/junit.xml")).toEqual({
      ok: true,
      value: [
        {
          name: "Api.PetsTests.returns pets",
          scope: "Api.PetsTests",
          outcome: "passed",
          message: "",
          file: "out/junit.xml",
        },
        {
          name: "Api.PetsTests.parses numbers",
          scope: "Api.PetsTests",
          outcome: "failed",
          message: "expected 1.5 got 15",
          file: "out/junit.xml",
        },
        {
          name: "Api.PetsTests.crashes",
          scope: "Api.PetsTests",
          outcome: "failed",
          message: "NullReferenceException at Api.Pets.Get() at x",
          file: "out/junit.xml",
        },
        { name: "skipped one", scope: "tests", outcome: "skipped", message: "", file: "out/junit.xml" },
      ],
    });
  });

  it("reads a single <testsuite> root", () => {
    const parsed = parseTestResults("junit", '<testsuite><testcase name="a"/></testsuite>', "r.xml");
    expect(parsed.ok && parsed.value.map((testCase) => testCase.name)).toEqual(["a"]);
  });

  it("reads TRX results, completing names from the test definitions", () => {
    expect(parseTestResults("trx", TRX, "TestResults/run.trx")).toEqual({
      ok: true,
      value: [
        {
          name: "PETSEO.Integration.Tests.PetsTests.Returns_count",
          scope: "PETSEO.Integration.Tests.PetsTests",
          outcome: "passed",
          message: "",
          file: "TestResults/run.trx",
        },
        {
          name: "Api.QueryTests.Parses_query",
          scope: "Api.QueryTests",
          outcome: "failed",
          message: "Assert.Equal() Failure Expected: 1.5 Actual:   15",
          file: "TestResults/run.trx",
        },
        {
          name: "Times_out",
          scope: "tests",
          outcome: "failed",
          message: "outcome Timeout",
          file: "TestResults/run.trx",
        },
        { name: "Not_run", scope: "tests", outcome: "skipped", message: "", file: "TestResults/run.trx" },
      ],
    });
  });

  it.each([
    ["junit", "<TestRun/>", "r.xml is not a JUnit XML document (root element <TestRun>)"],
    ["trx", "<testsuites/>", "r.xml is not a TRX document (root element <testsuites>)"],
    ["junit", "<testsuites>", "r.xml is not valid XML: element <testsuites> is not closed"],
  ] as const)("rejects %s input %s", (kind, xml, error) => {
    expect(parseTestResults(kind, xml, "r.xml")).toEqual({ ok: false, error });
  });

  it("shortens a long message", () => {
    const parsed = parseTestResults(
      "junit",
      `<testsuite><testcase name="a"><failure message="${"x".repeat(600)}"/></testcase></testsuite>`,
      "r.xml",
    );
    expect(parsed.ok && parsed.value[0]?.message).toBe(`${"x".repeat(497)}...`);
  });
});

describe("summarizeTests", () => {
  const testCase = (name: string, outcome: TestCase["outcome"]): TestCase => ({
    name,
    scope: "tests",
    outcome,
    message: "",
    file: "r.xml",
  });

  it("keeps one outcome per name, a failure winning over a pass and a pass over a skip", () => {
    const summary = summarizeTests([
      testCase("a", "passed"),
      testCase("a", "failed"),
      testCase("a", "passed"),
      testCase("b", "skipped"),
      testCase("b", "passed"),
    ]);
    expect([...summary.values()].map((entry) => [entry.name, entry.outcome])).toEqual([
      ["a", "failed"],
      ["b", "passed"],
    ]);
  });
});

describe("result files", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "compat-results-"));
    for (const path of [
      "a/TestResults/x.trx",
      "b/TestResults/y.trx",
      "node_modules/p/z.trx",
      ".git/w.trx",
      "a/x.xml",
    ]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "<TestRun/>");
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds files by glob, skipping .git and node_modules", async () => {
    expect(await findResultFiles(root, ["**/*.trx"])).toEqual({
      ok: true,
      value: ["a/TestResults/x.trx", "b/TestResults/y.trx"],
    });
  });

  it("removes only the matching files", async () => {
    expect(await removeResultFiles(root, ["**/TestResults/*.trx"])).toEqual({ ok: true, value: undefined });
    expect(await findResultFiles(root, ["**/*.{trx,xml}"])).toEqual({ ok: true, value: ["a/x.xml"] });
  });
});
