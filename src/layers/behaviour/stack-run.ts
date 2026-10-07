import type { RefTree } from "../../git/ref-tree.js";
import type { Side } from "../../model/finding.js";
import {
  type BackgroundProcess,
  findFreePort,
  startBackgroundProcess,
} from "../../process/background-process.js";
import { pollUrl } from "../../process/http-poll.js";
import { describeProcessError, getTailLines, runProcess } from "../../process/run-process.js";
import { err, ok, type Result } from "../../result.js";
import { runTreeCommand } from "../openapi/tree-command.js";
import { type BehaviourConfig, PORT_PLACEHOLDER } from "./config.js";
import {
  findResultFiles,
  readTestResults,
  removeResultFiles,
  summarizeTests,
  type TestCase,
} from "./test-results.js";

const OUTPUT_TAIL_LINES = 20;

export type MaterializedTree = { tree: RefTree; root: string };

export type StackRunOptions = {
  config: BehaviourConfig;
  trees: Record<Side, MaterializedTree>;
  /** The side each command runs at in this cycle. */
  sides: { start: Side; test: Side; stop: Side };
  env: NodeJS.ProcessEnv;
  log(message: string): void;
};

export type TestSummary = {
  /** Tests that failed in every attempt. */
  failed: TestCase[];
  /** Tests that failed first and passed in a retry. */
  flaky: string[];
  total: number;
};

export type StackRunOutcome = {
  tests: Result<TestSummary>;
  /** Set when `stop` failed; the stack may still be running. */
  stopError?: string;
};

/**
 * One cycle: picks a free port, runs `start`, runs the tests (with retries) and always runs
 * `stop` and stops a background app, also after a failure or a timeout.
 */
export async function runStackCycle(options: StackRunOptions): Promise<StackRunOutcome> {
  const port = await findFreePort();
  if (!port.ok) return { tests: port };
  const withPort = (text: string) => text.replaceAll(PORT_PLACEHOLDER, String(port.value));
  const env: NodeJS.ProcessEnv = { ...options.env, COMPAT_PORT: String(port.value) };
  const app: { process?: BackgroundProcess } = {};
  let tests: Result<TestSummary>;
  let stopError: string | undefined;
  try {
    const started = await startStack(options, { withPort, env, app });
    tests = started.ok ? await runTests(options, { withPort, env }) : started;
  } finally {
    stopError = await stopStack(options, { withPort, env });
    await app.process?.stop();
  }
  return stopError === undefined ? { tests } : { tests, stopError };
}

type CommandContext = { withPort(text: string): string; env: NodeJS.ProcessEnv };

async function startStack(
  options: StackRunOptions,
  context: CommandContext & { app: { process?: BackgroundProcess } },
): Promise<Result<void>> {
  const start = options.config.start;
  if (start === undefined) return ok(undefined);
  const { tree, root } = options.trees[options.sides.start];
  const label = `start command at ${tree.side} (${tree.ref})`;
  options.log(`starting the stack at ${tree.side} (${tree.ref})`);
  if (!start.background) {
    return runTreeCommand({
      run: context.withPort(start.run),
      tree,
      root,
      timeoutSeconds: start.timeoutSeconds,
      env: context.env,
      label: "start command",
    });
  }
  const started = await startBackgroundProcess({
    command: context.withPort(start.run),
    cwd: root,
    env: { ...context.env, COMPAT_SIDE: tree.side, COMPAT_REF: tree.ref, COMPAT_COMMIT: tree.commit },
  });
  if (!started.ok) return err(`${label}: ${started.error}`);
  const app = started.value;
  context.app.process = app;
  if (start.ready === undefined) return ok(undefined);
  const outcome = await pollUrl({
    url: context.withPort(start.ready),
    deadline: Date.now() + start.timeoutSeconds * 1000,
    getStopReason: () => describeExit(app),
  });
  if (outcome.status === "ready") return ok(undefined);
  const reason =
    outcome.status === "stopped"
      ? `${outcome.reason} before ${start.ready} answered`
      : `${start.ready} not ready after ${start.timeoutSeconds} s`;
  return err(`${label}: ${reason} (last: ${outcome.lastObservation})${outputTail(app.getOutput())}`);
}

async function runTests(options: StackRunOptions, context: CommandContext): Promise<Result<TestSummary>> {
  const { test, retries } = options.config;
  const { tree, root } = options.trees[options.sides.test];
  const label = `test command at ${tree.side} (${tree.ref})`;
  const globs = Array.isArray(test.results.path) ? test.results.path : [test.results.path];
  let failing = new Map<string, TestCase>();
  const flaky: string[] = [];
  let total = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0)
      options.log(`rerunning the tests, ${failing.size} failed (retry ${attempt} of ${retries})`);
    else options.log(`running the tests at ${tree.side} (${tree.ref})`);
    const cleared = await removeResultFiles(root, globs);
    if (!cleared.ok) return err(`${label}: ${cleared.error}`);
    const result = await runProcess({
      command: context.withPort(test.run),
      shell: true,
      cwd: root,
      env: { ...context.env, COMPAT_SIDE: tree.side, COMPAT_REF: tree.ref, COMPAT_COMMIT: tree.commit },
      timeoutMs: test.timeoutSeconds * 1000,
    });
    if (!result.ok) return err(describeProcessError(label, result.error));
    const files = await findResultFiles(root, globs);
    if (!files.ok) return err(`${label}: ${files.error}`);
    const output = [result.value.stdout.trimEnd(), result.value.stderr.trimEnd()].filter(Boolean).join("\n");
    if (files.value.length === 0) {
      return err(
        `${label} exited ${result.value.exitCode} and wrote no file matching ${globs.join(", ")}${outputTail(output)}`,
      );
    }
    const cases = await readTestResults(root, files.value, test.results.kind);
    if (!cases.ok) return err(`${label}: ${cases.error}`);
    const byName = summarizeTests(cases.value);
    if (attempt === 0) {
      if (byName.size === 0) return err(`${label}: the result files hold no test case`);
      total = byName.size;
      failing = new Map([...byName].filter(([, testCase]) => testCase.outcome === "failed"));
    } else {
      for (const name of [...failing.keys()]) {
        const rerun = byName.get(name);
        if (rerun === undefined) continue; // Not run again: the first failure stands.
        if (rerun.outcome === "failed") failing.set(name, rerun);
        else {
          failing.delete(name);
          flaky.push(name);
        }
      }
    }
    if (failing.size === 0) break;
  }
  return ok({ failed: [...failing.values()], flaky, total });
}

/** Runs `stop`; returns why it failed, or `undefined`. */
async function stopStack(options: StackRunOptions, context: CommandContext): Promise<string | undefined> {
  const stop = options.config.stop;
  if (stop === undefined) return undefined;
  const { tree, root } = options.trees[options.sides.stop];
  options.log(`stopping the stack at ${tree.side} (${tree.ref})`);
  const stopped = await runTreeCommand({
    run: context.withPort(stop.run),
    tree,
    root,
    timeoutSeconds: stop.timeoutSeconds,
    env: context.env,
    label: "stop command",
  });
  return stopped.ok ? undefined : stopped.error;
}

function describeExit(app: BackgroundProcess): string | null {
  const exit = app.getExit();
  if (exit === null) return null;
  return exit.signal ? `the app was stopped by ${exit.signal}` : `the app exited ${exit.code ?? 1}`;
}

function outputTail(output: string): string {
  const tail = getTailLines(output, OUTPUT_TAIL_LINES);
  return tail ? `; output: ${tail}` : "; the command printed nothing";
}
