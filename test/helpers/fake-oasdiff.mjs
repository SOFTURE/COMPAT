#!/usr/bin/env node
// Stands in for the oasdiff binary in tests. Behaviour is chosen by FAKE_OASDIFF_MODE:
// "changes" prints FAKE_OASDIFF_OUTPUT, "fail" exits 3, "garbage" prints non-JSON,
// "version-fail" exits 2 on --version.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_OASDIFF_LOG) appendFileSync(process.env.FAKE_OASDIFF_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === "--version" && process.env.FAKE_OASDIFF_MODE === "version-fail") {
  process.exit(2);
}
if (args[0] === "--version") {
  process.stdout.write("oasdiff version fake\n");
  process.exit(0);
}
const mode = process.env.FAKE_OASDIFF_MODE ?? "changes";
if (mode === "fail") {
  process.stderr.write("Error: failed to load base spec\n");
  process.exit(3);
}
if (mode === "garbage") {
  process.stdout.write("not json");
  process.exit(0);
}
process.stdout.write(process.env.FAKE_OASDIFF_OUTPUT ?? "[]");
