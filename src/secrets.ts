/**
 * Shared secret hygiene for tool output and spawned processes.
 *
 * One implementation on purpose: scrubbing rules previously lived
 * copy-pasted in four tools and had drifted (the widened `sk-` pattern was
 * fixed in one copy but not the others, leaving real Anthropic/OpenAI keys
 * unredacted).
 */

/** Output patterns replaced with [REDACTED]. */
const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic style keys. The charset must include `-` and `_`:
  // real keys look like sk-ant-api03-… and sk-proj-…, which the older
  // [a-zA-Z0-9]{20,} pattern could never match.
  /sk-[a-zA-Z0-9_-]{20,}/,
  /xoxb-[a-zA-Z0-9-]+/,
  /xapp-[a-zA-Z0-9-]+/,
  /ghp_[a-zA-Z0-9]{36}/,
  /gho_[a-zA-Z0-9]{36}/,
  /github_pat_[a-zA-Z0-9_]{22,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

/** Redacts known token shapes from arbitrary text. */
export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(new RegExp(pattern.source, "g"), "[REDACTED]");
  }
  return scrubbed;
}

/**
 * Env keys that must not reach spawned shells. Matched case-insensitively
 * against credential-bearing name shapes (API keys, tokens, secrets,
 * passwords, credentials).
 */
const ENV_SECRET_KEY = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;

/**
 * Returns a copy of `process.env` with credential-bearing variables removed.
 *
 * Spawning shells with a full `{ ...process.env }` hands every channel token
 * and model API key to whatever command runs — `echo $ANTHROPIC_API_KEY` then
 * flows straight into LLM context. Benign variables pass through unchanged.
 */
export function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_SECRET_KEY.test(key)) continue;
    env[key] = value;
  }
  return env;
}
