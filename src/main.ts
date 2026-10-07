import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  type CheckIo,
  EXIT_CANNOT_RUN,
  REPORT_FORMATS,
  type ReportFormat,
  runCheck,
} from "./commands/check.js";
import { FAIL_ON_VALUES, type FailOn } from "./model/gate.js";

export const USAGE = `Usage: softure-compat check --base <ref> --revision <ref> [options]

Tells whether the revision is backward compatible with the base (the release in production).

Options:
  --base <ref>            git ref running in production (required)
  --revision <ref>        git ref about to be released (required)
  --repo <dir>            repository directory (default: current directory)
  --config <file>         config file (default: <repo>/compat.config.json)
  --format <md|json>      report format (default: md)
  --output <file>         write the report to a file instead of stdout
  --fail-on <class>       breaking | rollback-risk | needs-action | never (default: breaking)
  --allow-incomplete      do not fail when a layer was skipped or failed
  -h, --help              show this help
  -v, --version           show the version

Exit codes: 0 gate passed, 1 gate failed, 2 the check could not run.
`;

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
      format: { type: "string", default: "md" },
      output: { type: "string" },
      "fail-on": { type: "string", default: "breaking" },
      "allow-incomplete": { type: "boolean", default: false },
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
  if (command !== "check" || rest.length > 0) {
    return usageError(
      io,
      command === undefined ? "missing command" : `unknown command "${[command, ...rest].join(" ")}"`,
    );
  }
  if (values.base === undefined || values.revision === undefined) {
    return usageError(io, "--base and --revision are required");
  }
  if (!isOneOf(REPORT_FORMATS, values.format)) {
    return usageError(io, `--format must be one of ${REPORT_FORMATS.join(", ")}`);
  }
  const failOn = values["fail-on"];
  if (!isOneOf(FAIL_ON_VALUES, failOn)) {
    return usageError(io, `--fail-on must be one of ${FAIL_ON_VALUES.join(", ")}`);
  }
  return runCheck(
    {
      base: values.base,
      revision: values.revision,
      repoDir: values.repo,
      configPath: values.config,
      format: values.format as ReportFormat,
      outputPath: values.output,
      failOn: failOn as FailOn,
      allowIncomplete: values["allow-incomplete"],
    },
    io,
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
