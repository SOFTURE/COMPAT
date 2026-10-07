import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_OASDIFF = fileURLToPath(new URL("./fake-oasdiff.mjs", import.meta.url));

/** Path of a real oasdiff binary: SOFTURE_COMPAT_OASDIFF, PATH, then ~/go/bin. */
export function findRealOasdiff(): string | undefined {
  const candidates = [process.env.SOFTURE_COMPAT_OASDIFF, "oasdiff", join(homedir(), "go", "bin", "oasdiff")];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Not usable; try the next one.
    }
  }
  return undefined;
}

/** Real-oasdiff tests run when the binary exists, and must run when COMPAT_REQUIRE_OASDIFF=1. */
export function shouldSkipRealOasdiff(binary: string | undefined): boolean {
  if (binary !== undefined) return false;
  if (process.env.COMPAT_REQUIRE_OASDIFF === "1") {
    throw new Error("COMPAT_REQUIRE_OASDIFF=1 but no oasdiff binary was found");
  }
  return true;
}
