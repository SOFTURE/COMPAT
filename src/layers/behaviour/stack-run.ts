import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RefTree } from "../../git/ref-tree.js";
import type { CommandOutput, Side } from "../../model/finding.js";
import {
  type BackgroundProcess,
  findFreePort,
  startBackgroundProcess,
} from "../../process/background-process.js";
import { pollUrl } from "../../process/http-poll.js";
import { describeProcessError, getTailLines, runProcess } from "../../process/run-process.js";
import { err, ok, type Result } from "../../result.js";
import { type BehaviourConfig, PORT_PLACEHOLDER } from "./config.js";
import {
  findResultFiles,
  readTestResults,
  removeResultFiles,
  summarizeTests,
  type TestCase,
} from "./test-results.js";

const OUTPUT_TAIL_LINES = 40;

export type MaterializedTree = { tree: RefTree; root: string };

/** `baseline` runs the tests against their own side's stack; `check` against the other side's. */
export type CycleName = "baseline" | "check";

export type StackRunOptions = {
  config: BehaviourConfig;
  trees: Record<Side, MaterializedTree>;
  cycle: CycleName;
  /** The side each command runs at in this cycle. */
  sides: { start: Side; test: Side; stop: Side; collect: Side };
  /** Where the full output of every command is written. */
  logDir: string;
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

/** Why a command failed, and what it printed when it printed anything. */
export type StackFailure = { error: string; output?: CommandOutput };

export type StackRunOutcome = {
  tests: Result<TestSummary, StackFailure>;
  /** Set when `stop` failed; the stack may still be running. */
  stopError?: StackFailure;
  /** Set when `collect` ran: where its output is, or why it failed. */
  collected?: Result<string, string>;
};

/**
 * One cycle: picks a free port, runs `start`, runs the tests (with retries), runs `collect` when something failed,
 * and always runs `stop` and stops a background app, also after a failure or a timeout. Every command's full output
 * goes to a file in `logDir`.
 */
export async function runStackCycle(options: StackRunOptions): Promise<StackRunOutcome> {
  const port = await findFreePort();
  if (!port.ok) return { tests: err({ error: port.error }) };
  const withPort = (text: string) => text.replaceAll(PORT_PLACEHOLDER, String(port.value));
  const env: NodeJS.ProcessEnv = { ...options.env, COMPAT_PORT: String(port.value) };
  const context: CommandContext = { withPort, env, app: {} };
  let tests: Result<TestSummary, StackFailure> | undefined;
  let collected: Result<string, string> | undefined;
  let stopError: StackFailure | undefined;
  try {
    const started = await startStack(options, context);
    tests = started.ok ? await runTests(options, context) : started;
    if (!tests.ok || tests.value.failed.length > 0) collected = await collect(options, context);
  } finally {
    stopError = await stopStack(options, context);
    await context.app.process?.stop();
    await saveBackgroundOutput(options, context);
  }
  return {
    tests,
    ...(stopError === undefined ? {} : { stopError }),
    ...(collected === undefined ? {} : { collected }),
  };
}

type CommandContext = {
  withPort(text: string): string;
  env: NodeJS.ProcessEnv;
  app: { process?: BackgroundProcess };
};

type ShellCommand = { name: string; run: string; side: Side; timeoutSeconds: number; logName: string };

/** A command's full output: stdout, then stderr, each under its own heading. */
function formatLog(command: string, stdout: string, stderr: string): string {
  return `$ ${command}\n\n# stdout\n${stdout.trimEnd()}\n\n# stderr\n${stderr.trimEnd()}\n`;
}

function joinOutput(stdout: string, stderr: string): string {
  return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
}

/** Writes one log file; a write that fails is logged and leaves the output without a file. */
async function writeLog(
  options: StackRunOptions,
  name: string,
  content: string,
): Promise<string | undefined> {
  const path = join(options.logDir, name);
  try {
    await mkdir(options.logDir, { recursive: true });
    await writeFile(path, content, "utf8");
    return path;
  } catch (error) {
    options.log(`cannot write the command log ${path} (${(error as NodeJS.ErrnoException).code ?? error})`);
    return undefined;
  }
}

function describeOutput(label: string, output: string, log: string | undefined): StackFailure {
  const where = log === undefined ? "" : `; full output in ${log}`;
  const tail = getTailLines(output, OUTPUT_TAIL_LINES);
  const error = tail === "" ? `${label}${where}; the command printed nothing` : `${label}${where}`;
  return { error, output: { command: label, tail, ...(log === undefined ? {} : { log }) } };
}

/** Runs a shell command at its side's tree and writes its output to the log, whatever the outcome. */
async function runShell(
  options: StackRunOptions,
  context: CommandContext,
  command: ShellCommand,
): Promise<Result<{ exitCode: number; stdout: string; stderr: string; log?: string }, StackFailure>> {
  const { tree, root } = options.trees[command.side];
  const label = `${command.name} at ${tree.side} (${tree.ref})`;
  const run = context.withPort(command.run);
  const result = await runProcess({
    command: run,
    shell: true,
    cwd: root,
    env: { ...context.env, COMPAT_SIDE: tree.side, COMPAT_REF: tree.ref, COMPAT_COMMIT: tree.commit },
    timeoutMs: command.timeoutSeconds * 1000,
  });
  if (!result.ok) {
    if (result.error.kind === "spawn-failed")
      return err({ error: describeProcessError(label, result.error) });
    const { stdout, stderr } = result.error;
    const log = await writeLog(options, command.logName, formatLog(run, stdout, stderr));
    return err(describeOutput(describeProcessError(label, result.error), joinOutput(stdout, stderr), log));
  }
  const { stdout, stderr, exitCode } = result.value;
  const log = await writeLog(options, command.logName, formatLog(run, stdout, stderr));
  return ok({ exitCode, stdout, stderr, ...(log === undefined ? {} : { log }) });
}

/** Runs a command that must exit 0. */
async function runChecked(
  options: StackRunOptions,
  context: CommandContext,
  command: ShellCommand,
): Promise<Result<string | undefined, StackFailure>> {
  const result = await runShell(options, context, command);
  if (!result.ok) return result;
  if (result.value.exitCode === 0) return ok(result.value.log);
  const { tree } = options.trees[command.side];
  const label = `${command.name} at ${tree.side} (${tree.ref}) exited ${result.value.exitCode}`;
  return err(describeOutput(label, joinOutput(result.value.stdout, result.value.stderr), result.value.log));
}

function getLogName(options: StackRunOptions, command: string, side: Side, suffix = ""): string {
  return `${options.cycle}-${command}-${side}${suffix}.log`;
}

async function startStack(
  options: StackRunOptions,
  context: CommandContext,
): Promise<Result<void, StackFailure>> {
  const start = options.config.start;
  if (start === undefined) return ok(undefined);
  const side = options.sides.start;
  const { tree, root } = options.trees[side];
  const label = `start command at ${tree.side} (${tree.ref})`;
  options.log(`starting the stack at ${tree.side} (${tree.ref})`);
  if (!start.background) {
    const started = await runChecked(options, context, {
      name: "start command",
      run: start.run,
      side,
      timeoutSeconds: start.timeoutSeconds,
      logName: getLogName(options, "start", side),
    });
    return started.ok ? ok(undefined) : started;
  }
  const started = await startBackgroundProcess({
    command: context.withPort(start.run),
    cwd: root,
    env: { ...context.env, COMPAT_SIDE: tree.side, COMPAT_REF: tree.ref, COMPAT_COMMIT: tree.commit },
  });
  if (!started.ok) return err({ error: `${label}: ${started.error}` });
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
  // The app's output so far; `saveBackgroundOutput` rewrites the file with everything once the app is stopped.
  const logName = getLogName(options, "start", side);
  const log = await writeLog(options, logName, `$ ${context.withPort(start.run)}\n\n${app.getOutput()}`);
  return err(describeOutput(`${label}: ${reason} (last: ${outcome.lastObservation})`, app.getOutput(), log));
}

/** Writes everything a background app printed, once it is stopped. */
async function saveBackgroundOutput(options: StackRunOptions, context: CommandContext): Promise<void> {
  const app = context.app.process;
  const start = options.config.start;
  if (app === undefined || start === undefined) return;
  await writeLog(
    options,
    getLogName(options, "start", options.sides.start),
    `$ ${context.withPort(start.run)}\n\n${app.getOutput()}`,
  );
}

async function runTests(
  options: StackRunOptions,
  context: CommandContext,
): Promise<Result<TestSummary, StackFailure>> {
  const { test, retries } = options.config;
  const side = options.sides.test;
  const { tree, root } = options.trees[side];
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
    if (!cleared.ok) return err({ error: `${label}: ${cleared.error}` });
    const result = await runShell(options, context, {
      name: "test command",
      run: test.run,
      side,
      timeoutSeconds: test.timeoutSeconds,
      logName: getLogName(options, "test", side, attempt === 0 ? "" : `-retry${attempt}`),
    });
    if (!result.ok) return result;
    const files = await findResultFiles(root, globs);
    if (!files.ok) return err({ error: `${label}: ${files.error}` });
    if (files.value.length === 0) {
      return err(
        describeOutput(
          `${label} exited ${result.value.exitCode} and wrote no file matching ${globs.join(", ")}`,
          joinOutput(result.value.stdout, result.value.stderr),
          result.value.log,
        ),
      );
    }
    const cases = await readTestResults(root, files.value, test.results.kind);
    if (!cases.ok) return err({ error: `${label}: ${cases.error}` });
    const byName = summarizeTests(cases.value);
    if (attempt === 0) {
      if (byName.size === 0) return err({ error: `${label}: the result files hold no test case` });
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

/** Runs `collect`, before `stop` tears the stack down; returns where its output is, or why it failed. */
async function collect(
  options: StackRunOptions,
  context: CommandContext,
): Promise<Result<string, string> | undefined> {
  const command = options.config.collect;
  if (command === undefined) return undefined;
  const side = options.sides.collect;
  const { tree } = options.trees[side];
  options.log(`collecting the stack's output at ${tree.side} (${tree.ref})`);
  const collected = await runChecked(options, context, {
    name: "collect command",
    run: command.run,
    side,
    timeoutSeconds: command.timeoutSeconds,
    logName: getLogName(options, "collect", side),
  });
  if (!collected.ok) return err(collected.error.error);
  return collected.value === undefined
    ? err("collect command ran, but its output could not be written")
    : ok(collected.value);
}

/** Runs `stop`; returns why it failed, or `undefined`. */
async function stopStack(
  options: StackRunOptions,
  context: CommandContext,
): Promise<StackFailure | undefined> {
  const stop = options.config.stop;
  if (stop === undefined) return undefined;
  const side = options.sides.stop;
  const { tree } = options.trees[side];
  options.log(`stopping the stack at ${tree.side} (${tree.ref})`);
  const stopped = await runChecked(options, context, {
    name: "stop command",
    run: stop.run,
    side,
    timeoutSeconds: stop.timeoutSeconds,
    logName: getLogName(options, "stop", side),
  });
  return stopped.ok ? undefined : stopped.error;
}

function describeExit(app: BackgroundProcess): string | null {
  const exit = app.getExit();
  if (exit === null) return null;
  return exit.signal ? `the app was stopped by ${exit.signal}` : `the app exited ${exit.code ?? 1}`;
}
