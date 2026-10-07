import type { Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { globToRegExp } from "../../git/glob.js";
import { err, ok, type Result } from "../../result.js";
import type { ResultsKind } from "./config.js";
import { findChild, findElements, parseXml, type XmlElement } from "./xml.js";

export type TestOutcome = "passed" | "failed" | "skipped";

export type TestCase = {
  /** The full test name, for example `Pets.Api.Tests.PetsEndpoint.ReturnsCount`. */
  name: string;
  /** The test class, or `tests` when the format does not name one. */
  scope: string;
  outcome: TestOutcome;
  /** The first lines of the failure message; empty unless failed. */
  message: string;
  /** The result file, relative to the tree the tests ran in. */
  file: string;
};

const DEFAULT_SCOPE = "tests";
const MESSAGE_MAX_LINES = 3;
const MESSAGE_MAX_CHARS = 500;
/** Folders never searched for result files: they are large and hold no results of this run. */
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);

const TRX_FAILED = new Set(["Failed", "Error", "Timeout", "Aborted"]);
const TRX_PASSED = new Set(["Passed", "PassedButRunAborted", "Warning"]);

/** Reads the test cases of one result file of the given kind. */
export function parseTestResults(kind: ResultsKind, xml: string, file: string): Result<TestCase[]> {
  const document = parseXml(xml);
  if (!document.ok) return err(`${file} is not valid XML: ${document.error}`);
  return kind === "junit" ? readJunit(document.value, file) : readTrx(document.value, file);
}

function readJunit(root: XmlElement, file: string): Result<TestCase[]> {
  if (root.name !== "testsuites" && root.name !== "testsuite") {
    return err(`${file} is not a JUnit XML document (root element <${root.name}>)`);
  }
  const cases = findElements(root, "testcase").map((testcase): TestCase => {
    const className = testcase.attributes.classname ?? "";
    const testName = testcase.attributes.name ?? "";
    const failure = findChild(testcase, "failure") ?? findChild(testcase, "error");
    const outcome: TestOutcome = failure ? "failed" : findChild(testcase, "skipped") ? "skipped" : "passed";
    return {
      name: joinName(className, testName),
      scope: className || DEFAULT_SCOPE,
      outcome,
      message: failure ? shortenMessage(failure.attributes.message || failure.text) : "",
      file,
    };
  });
  return ok(cases);
}

function readTrx(root: XmlElement, file: string): Result<TestCase[]> {
  if (root.name !== "TestRun") return err(`${file} is not a TRX document (root element <${root.name}>)`);
  const classNames = new Map<string, string>();
  for (const definition of findElements(root, "UnitTest")) {
    const method = findChild(definition, "TestMethod");
    const id = definition.attributes.id;
    if (id !== undefined && method?.attributes.className) {
      // `className` may be assembly-qualified: `Ns.Class, Assembly, Version=...`.
      classNames.set(id, (method.attributes.className.split(",")[0] as string).trim());
    }
  }
  // Only top-level results: data-driven tests repeat their rows under `InnerResults`.
  const results =
    findChild(root, "Results")?.children.filter((child) => child.name === "UnitTestResult") ?? [];
  const cases = results.map((result): TestCase => {
    const className = classNames.get(result.attributes.testId ?? "") ?? "";
    const testName = result.attributes.testName ?? "";
    const rawOutcome = result.attributes.outcome ?? "";
    const outcome: TestOutcome = TRX_FAILED.has(rawOutcome)
      ? "failed"
      : TRX_PASSED.has(rawOutcome)
        ? "passed"
        : "skipped";
    const output = findChild(result, "Output");
    const errorInfo = output ? findChild(output, "ErrorInfo") : undefined;
    const message = errorInfo ? (findChild(errorInfo, "Message")?.text ?? "") : "";
    return {
      // xUnit writes the full name as `testName`, MSTest only the method name.
      name: testName.startsWith(`${className}.`) ? testName : joinName(className, testName),
      scope: className || DEFAULT_SCOPE,
      outcome,
      message: outcome === "failed" ? shortenMessage(message || `outcome ${rawOutcome}`) : "",
      file,
    };
  });
  return ok(cases);
}

function joinName(className: string, testName: string): string {
  if (className === "") return testName;
  if (testName === "") return className;
  return `${className}.${testName}`;
}

function shortenMessage(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, MESSAGE_MAX_LINES);
  const joined = lines.join(" ");
  return joined.length > MESSAGE_MAX_CHARS ? `${joined.slice(0, MESSAGE_MAX_CHARS - 3)}...` : joined;
}

/** Files under `root` whose `/`-separated relative path matches any glob, sorted. */
export async function findResultFiles(root: string, globs: string[]): Promise<Result<string[]>> {
  const patterns = globs.map(globToRegExp);
  const found: string[] = [];
  const visit = async (relative: string): Promise<Result<void>> => {
    let entries: Dirent[];
    try {
      entries = await readdir(relative === "" ? root : join(root, relative), { withFileTypes: true });
    } catch (error) {
      return err(`cannot list ${relative || "."} (${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"})`);
    }
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_FOLDERS.has(entry.name)) continue;
        const nested = await visit(path);
        if (!nested.ok) return nested;
      } else if (entry.isFile() && patterns.some((pattern) => pattern.test(path))) {
        found.push(path);
      }
    }
    return ok(undefined);
  };
  const walked = await visit("");
  if (!walked.ok) return walked;
  return ok(found.sort());
}

/** Deletes the result files a previous attempt left, so an attempt reads only its own results. */
export async function removeResultFiles(root: string, globs: string[]): Promise<Result<void>> {
  const files = await findResultFiles(root, globs);
  if (!files.ok) return files;
  for (const file of files.value) {
    try {
      await rm(join(root, file), { force: true });
    } catch (error) {
      return err(`cannot remove the old result file ${file} (${(error as NodeJS.ErrnoException).code})`);
    }
  }
  return ok(undefined);
}

/** Reads and parses every result file; one unreadable file fails the whole read. */
export async function readTestResults(
  root: string,
  files: string[],
  kind: ResultsKind,
): Promise<Result<TestCase[]>> {
  const cases: TestCase[] = [];
  for (const file of files) {
    let xml: string;
    try {
      xml = await readFile(join(root, file), "utf8");
    } catch (error) {
      return err(`cannot read the result file ${file} (${(error as NodeJS.ErrnoException).code})`);
    }
    const parsed = parseTestResults(kind, xml, file);
    if (!parsed.ok) return parsed;
    cases.push(...parsed.value);
  }
  return ok(cases);
}

/**
 * One outcome per test name: a name reported several times (parameterized cases) failed when
 * any instance failed, and passed when any instance passed.
 */
export function summarizeTests(cases: TestCase[]): Map<string, TestCase> {
  const byName = new Map<string, TestCase>();
  const rank: Record<TestOutcome, number> = { skipped: 0, passed: 1, failed: 2 };
  for (const testCase of cases) {
    const known = byName.get(testCase.name);
    if (known === undefined || rank[testCase.outcome] > rank[known.outcome])
      byName.set(testCase.name, testCase);
  }
  return byName;
}
