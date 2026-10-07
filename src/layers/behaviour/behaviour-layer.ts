import type { RefTree } from "../../git/ref-tree.js";
import type { Finding, LayerResult, Side } from "../../model/finding.js";
import { defineLayer } from "../layer.js";
import {
  type AcceptEntry,
  type BehaviourConfig,
  behaviourConfigSchema,
  matchesTestPattern,
} from "./config.js";
import { type MaterializedTree, runStackCycle, type TestSummary } from "./stack-run.js";
import type { TestCase } from "./test-results.js";

export const BEHAVIOUR_LAYER = "behaviour";

const LISTED_NAMES = 10;

export const behaviourLayer = defineLayer({
  name: BEHAVIOUR_LAYER,
  description: "The base ref's black-box tests run against the revision's running stack",
  configSchema: behaviourConfigSchema,
  async run(context) {
    const { config } = context;
    const notes: string[] = [];
    const errors: string[] = [];
    const fail = (error: string, findings: Finding[] = []): LayerResult => ({
      layer: BEHAVIOUR_LAYER,
      status: "failed",
      error,
      findings,
      notes,
    });

    const trees: Partial<Record<Side, MaterializedTree>> = {};
    for (const side of getUsedSides(config)) {
      const tree = side === "base" ? context.base : context.revision;
      const root = await tree.materialize();
      if (!root.ok) return fail(`cannot materialize ${side} (${tree.ref}): ${root.error}`);
      trees[side] = { tree, root: root.value };
    }
    const materialized = trees as Record<Side, MaterializedTree>;
    const testSide = config.test.side;
    // Without `start` and `stop` the stack runs outside the tool; it is still the other side's.
    const stackSide: Side =
      config.start?.side ?? config.stop?.side ?? (testSide === "base" ? "revision" : "base");
    const stackTree = stackSide === "base" ? context.base : context.revision;

    let alreadyFailing = new Set<string>();
    if (config.baseline) {
      const baseline = await runStackCycle({
        config,
        trees: materialized,
        sides: { start: testSide, test: testSide, stop: testSide },
        env: context.env,
        log: (message) => context.log(`baseline: ${message}`),
      });
      if (baseline.stopError !== undefined) errors.push(`baseline: ${baseline.stopError}`);
      if (!baseline.tests.ok) return fail([`baseline: ${baseline.tests.error}`, ...errors].join("; "));
      alreadyFailing = new Set(baseline.tests.value.failed.map((testCase) => testCase.name));
      notes.push(describeBaseline(baseline.tests.value, materialized[testSide].tree.ref));
    }

    const cycle = await runStackCycle({
      config,
      trees: materialized,
      sides: {
        start: config.start?.side ?? stackSide,
        test: testSide,
        stop: config.stop?.side ?? stackSide,
      },
      env: context.env,
      log: context.log,
    });
    if (cycle.stopError !== undefined) errors.push(cycle.stopError);
    if (!cycle.tests.ok) return fail([cycle.tests.error, ...errors].join("; "));

    const summary = cycle.tests.value;
    const testTree = materialized[testSide].tree;
    notes.push(
      `${summary.total} test(s) from ${testSide} (${testTree.ref}) ran against the ${stackSide} (${stackTree.ref}) stack, ` +
        `${summary.failed.length} failed`,
    );
    if (summary.flaky.length > 0) {
      notes.push(
        `${summary.flaky.length} test(s) failed and then passed on a retry: ${listNames(summary.flaky)}`,
      );
    }
    const reported = summary.failed.filter((testCase) => !alreadyFailing.has(testCase.name));
    const dropped = summary.failed.length - reported.length;
    if (dropped > 0) notes.push(`${dropped} failed test(s) also fail at the baseline and are not reported`);

    const findings = reported.map((testCase) =>
      toFinding(testCase, { testTree, stackSide, stackRef: stackTree.ref }),
    );
    const accepted = applyAccept(findings, config.accept ?? []);
    notes.push(...accepted.notes);
    if (errors.length > 0) return fail(errors.join("; "), accepted.findings);
    return {
      layer: BEHAVIOUR_LAYER,
      status: "ran",
      findings: accepted.findings,
      notes,
    } satisfies LayerResult;
  },
});

function getUsedSides(config: BehaviourConfig): Side[] {
  const sides = new Set<Side>([config.test.side]);
  if (config.start) sides.add(config.start.side);
  if (config.stop) sides.add(config.stop.side);
  return [...sides];
}

function describeBaseline(summary: TestSummary, ref: string): string {
  if (summary.failed.length === 0)
    return `baseline: all ${summary.total} test(s) pass against the ${ref} stack`;
  return (
    `baseline: ${summary.failed.length} of ${summary.total} test(s) already fail against the ${ref} stack and ` +
    `are not reported: ${listNames(summary.failed.map((testCase) => testCase.name))}`
  );
}

function listNames(names: string[]): string {
  const shown = names.slice(0, LISTED_NAMES).join(", ");
  return names.length > LISTED_NAMES ? `${shown} and ${names.length - LISTED_NAMES} more` : shown;
}

type FindingContext = { testTree: RefTree; stackSide: Side; stackRef: string };

function toFinding(testCase: TestCase, context: FindingContext): Finding {
  const where = `fails against the ${context.stackSide} (${context.stackRef}) stack`;
  return {
    layer: BEHAVIOUR_LAYER,
    scope: testCase.scope,
    id: "base-test-failed",
    subject: testCase.name,
    class: "breaking",
    message: testCase.message ? `${where}: ${testCase.message}` : where,
    evidence: [
      {
        side: context.testTree.side,
        ref: context.testTree.ref,
        commit: context.testTree.commit,
        path: testCase.file,
      },
    ],
  };
}

type AcceptOutcome = { findings: Finding[]; notes: string[] };

function applyAccept(findings: Finding[], accept: AcceptEntry[]): AcceptOutcome {
  const usage = accept.map(() => 0);
  const result = findings.map((finding) => {
    const position = accept.findIndex((entry) => matchesTestPattern(finding.subject, entry.test));
    if (position === -1) return finding;
    usage[position] = (usage[position] ?? 0) + 1;
    return { ...finding, accepted: { reason: (accept[position] as AcceptEntry).reason } };
  });
  const notes = accept.map((entry, position) => {
    const count = usage[position] ?? 0;
    return count === 0
      ? `accept entry for ${entry.test} matched no failed test; remove it if the test passes again`
      : `accept entry for ${entry.test} accepted ${count} failed test(s)`;
  });
  return { findings: result, notes };
}
