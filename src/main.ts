import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type CheckIo, EXIT_CANNOT_RUN, REPORT_FORMATS, runCheck } from "./commands/check.js";
import { runInit } from "./commands/init.js";
import { NO_DOWNLOAD_ENV_VAR } from "./layers/openapi/oasdiff-download.js";
import { FAIL_ON_VALUES } from "./model/gate.js";

export const USAGE = `Usage: softure-compat check --base <ref> --revision <ref> [options]
       softure-compat init [--repo <dir>] [--config <file>] [--force]

check   tells whether the revision is backward compatible with the base (the release in production)
init    writes a starter compat.config.json from the files committed at HEAD

Options:
  --base <ref>            check: git ref running in production (required)
  --revision <ref>        check: git ref about to be released (required)
  --repo <dir>            repository directory (default: current directory)
  --config <file>         config file (default: <repo>/compat.config.json)
  --format <md|json>      check: report format (default: md)
  --output <file>         check: write the report to a file instead of stdout
  --fail-on <class>       check: breaking | rollback-risk | needs-action | never (default: breaking)
  --allow-incomplete      check: do not fail when a layer was skipped or failed
  --no-download           check: never download oasdiff; skip the openapi layer when it is missing
  --force                 init: overwrite an existing config file
  -h, --help              show this help
  -v, --version           show the version

Exit codes: 0 gate passed (init: config written), 1 gate failed, 2 the command could not run.
`;

const CHECK_ONLY_FLAGS = [
  "base",
  "revision",
  "format",
  "output",
  "fail-on",
  "allow-incomplete",
  "no-download",
] as const;

function readVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  return packageJson.version ?? "unknown";
}

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

async function runMain(argv: string[], io: CheckIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      base: { type: "string" },
      revision: { type: "string" },
      repo: { type: "string" },
      config: { type: "string" },
      format: { type: "string" },
      output: { type: "string" },
      "fail-on": { type: "string" },
      "allow-incomplete": { type: "boolean" },
      "no-download": { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (values.version) {
    io.stdout(`${readVersion()}\n`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if ((command !== "check" && command !== "init") || rest.length > 0) {
    return usageError(
      io,
      command === undefined ? "missing command" : `unknown command "${[command, ...rest].join(" ")}"`,
    );
  }
  if (command === "init") {
    const checkOnly = CHECK_ONLY_FLAGS.find((flag) => values[flag] !== undefined);
    if (checkOnly !== undefined) return usageError(io, `--${checkOnly} is only for check`);
    return runInit({ repoDir: values.repo, configPath: values.config, force: values.force ?? false }, io);
  }
  if (values.force !== undefined) return usageError(io, "--force is only for init");
  if (values.base === undefined || values.revision === undefined) {
    return usageError(io, "--base and --revision are required");
  }
  const format = values.format ?? "md";
  if (!isOneOf(REPORT_FORMATS, format)) {
    return usageError(io, `--format must be one of ${REPORT_FORMATS.join(", ")}`);
  }
  const failOn = values["fail-on"] ?? "breaking";
  if (!isOneOf(FAIL_ON_VALUES, failOn)) {
    return usageError(io, `--fail-on must be one of ${FAIL_ON_VALUES.join(", ")}`);
  }
  return runCheck(
    {
      base: values.base,
      revision: values.revision,
      repoDir: values.repo,
      configPath: values.config,
      format,
      outputPath: values.output,
      failOn,
      allowIncomplete: values["allow-incomplete"] ?? false,
    },
    // Layers read the opt-out from the environment, the same switch CI can set without the flag.
    values["no-download"] ? { ...io, env: { ...io.env, [NO_DOWNLOAD_ENV_VAR]: "1" } } : io,
  );
}

function usageError(io: CheckIo, message: string): number {
  io.stderr(`softure-compat: ${message}\n\n${USAGE}`);
  return EXIT_CANNOT_RUN;
}

/** Runs the CLI and returns the exit code. Never throws: an unexpected error is exit 2. */
export async function main(argv: string[], io: CheckIo): Promise<number> {
  try {
    return await runMain(argv, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isArgsError = (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS") ?? false;
    if (isArgsError) return usageError(io, message);
    io.stderr(`softure-compat: unexpected error: ${message}\n`);
    return EXIT_CANNOT_RUN;
  }
}
