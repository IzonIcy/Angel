import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * OS-level sandboxing for the bash tool.
 *
 * The blocked-pattern list in bash.ts is tripwire telemetry, not a boundary.
 * This module provides the actual boundary on macOS via Seatbelt
 * (/usr/bin/sandbox-exec): spawned shells get a profile that denies
 * filesystem writes everywhere except the working directory and temp space,
 * and can additionally deny all network access.
 *
 * Modes:
 *  - "off"        legacy behavior, no sandbox
 *  - "filesystem" writes restricted to workdir + temp (default on macOS)
 *  - "full"       filesystem restrictions AND network denied
 *
 * Non-macOS platforms have no implementation yet and resolve to "off"
 * rather than pretending.
 */

export type SandboxMode = "off" | "filesystem" | "full";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function sandboxExecAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/** Resolve the effective mode: explicit config wins, otherwise a safe
 *  platform-dependent default. Unknown config values fail closed to "off"
 *  only after warning; silently upgrading callers to stricter-than-asked
 *  modes would break their workflows. */
export function resolveSandboxMode(
  configured: string | undefined,
  logWarn: (msg: string) => void = () => {},
): SandboxMode {
  if (configured !== undefined) {
    if (
      configured === "off" ||
      configured === "filesystem" ||
      configured === "full"
    ) {
      if (configured !== "off" && !sandboxExecAvailable()) {
        logWarn(
          `security.sandbox=${configured} requested but ${SANDBOX_EXEC} is not available; running unsandboxed`,
        );
        return "off";
      }
      return configured;
    }
    logWarn(
      `unknown security.sandbox value "${configured}"; disabling sandbox`,
    );
    return "off";
  }

  // Default: filesystem-restricted on macOS where we know the mechanism,
  // off elsewhere until an equivalent exists.
  return sandboxExecAvailable() ? "filesystem" : "off";
}

/**
 * Build a Seatbelt profile. Strategy is deny-writes-first, allow-specific-
 * paths-second: starting from (allow default) and carving out write access
 * keeps ordinary tooling (git, node, compilers writing caches) working,
 * which is what makes this sandbox survive contact with real usage.
 */
export function buildSeatbeltProfile(
  workDir: string,
  mode: Exclude<SandboxMode, "off">,
): string {
  const resolvedWorkDir = path.resolve(workDir);

  const lines: string[] = ["(version 1)", "(allow default)"];

  // Deny every write, then re-allow the places legitimate shell work needs.
  lines.push("(deny file-write*)");
  lines.push(`(allow file-write* (subpath "${resolvedWorkDir}"))`);

  // Temp space: both the bare and /private-prefixed spellings macOS uses.
  lines.push('(allow file-write* (subpath "/tmp"))');
  lines.push('(allow file-write* (subpath "/private/tmp"))');
  lines.push('(allow file-write* (regex #"^/private/var/folders/"))');
  lines.push('(allow file-write* (regex #"^/var/folders/"))');

  // Character devices shells and tools expect to write.
  for (const dev of [
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/tty",
    "/dev/console",
  ]) {
    lines.push(`(allow file-write* (literal "${dev}"))`);
  }

  // PTY allocation and job control need these.
  lines.push('(allow file-write* (regex #"^/dev/(pts|ttys)/"))');

  if (mode === "full") {
    lines.push("(deny network*)");
    lines.push("(deny system-socket)");
  }

  return lines.join("\n") + "\n";
}

/**
 * Materialize the profile to a stable temp-file path keyed by its content
 * hash so repeated spawns reuse one file instead of churning the disk.
 */
export function writeProfileFile(profile: string): string {
  const hash = createHash("sha256").update(profile).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "angel-sandbox");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `profile-${hash}.sb`);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, profile, { encoding: "utf8", flag: "wx" });
  }
  return filePath;
}

/**
 * Wrap a `bash -c <cmd>` spawn in the sandbox, or return the argv unchanged
 * when mode is "off". The returned argv always ends with the same
 * `/bin/bash -c` shape callers already handle.
 */
export function wrapWithSandbox(
  command: string,
  workDir: string,
  mode: SandboxMode,
): string[] {
  if (mode === "off" || !sandboxExecAvailable()) {
    return ["/bin/bash", "-c", command];
  }
  const profilePath = writeProfileFile(buildSeatbeltProfile(workDir, mode));
  return [SANDBOX_EXEC, "-f", profilePath, "/bin/bash", "-c", command];
}
