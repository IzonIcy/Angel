import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Shared SSRF guard for every tool that fetches URLs (web_fetch, browser,
 * remote, etc). Previous versions matched the URL string against a handful of
 * regexes: that missed redirect targets, DNS rebinding, alternate IP
 * encodings (127.1, 2130706433, 0x7f000001, octal), IPv4-mapped IPv6, and
 * userinfo tricks.
 *
 * This version resolves the hostname itself and rejects the request if ANY
 * resolved address falls in a private/loopback/link-local/reserved range.
 * Failing to resolve also fails closed: an unresolvable host is not a host
 * we can vouch for.
 *
 * Limitations (documented, not hidden): exotic IPv6 spellings of private
 * addresses can still slip past the string checks below, and a TOCTOU window
 * exists between our lookup and the actual connect. That's a far smaller
 * surface than string matching, which is what we had before.
 */

const SCHEME_RE = /^https?:\/\//i;
const INTEGER_HOST_RE = /^\d+$/;
const HEX_HOST_RE = /^0x[0-9a-f]+$/i;

// [start, end] inclusive, as 32-bit unsigned integers.
const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8        "this network"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8       private
  [0x64400000, 0x647fffff], // 100.64.0.0/10    CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8      loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16   link-local
  [0xac100000, 0xac1fffff], // 172.16.0.0/12    private
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24     TEST-NET-1
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16   private
  [0xc6120000, 0xc633ffff], // 198.18.0.0/15    benchmarking
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24  TEST-NET-2
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24   TEST-NET-3
  [0xe0000000, 0xffffffff], // 224.0.0.0/3      multicast/reserved/broadcast
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return -1;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return -1;
    // Leading zeros mean octal to most URL parsers (0177.0.0.1 == 127.0.0.1).
    // Never seen a legit decimal IP with them; treat as suspicious.
    if (part.length > 1 && part.startsWith("0")) return -1;
    const octet = Number(part);
    if (octet > 255) return -1;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === -1) return true; // unparseable → can't verify → block
  return PRIVATE_IPV4_RANGES.some(([start, end]) => n >= start && n <= end);
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (
    lower === "::" ||
    lower === "::1" ||
    lower === "0:0:0:0:0:0:0:0" ||
    lower === "0:0:0:0:0:0:0:1"
  )
    return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  )
    return true; // fe80::/10 link-local
  if (lower.startsWith("ff")) return true; // ff00::/8 multicast
  if (lower.startsWith("2001:db8")) return true; // documentation range
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local")
  )
    return true;
  if (INTEGER_HOST_RE.test(lower) || HEX_HOST_RE.test(lower)) return true;
  return false;
}

function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true; // not an IP we recognize → block
}

const DNS_TIMEOUT_MS = 3000;

async function resolveHost(hostname: string): Promise<string[]> {
  const result = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("DNS lookup timed out")),
        DNS_TIMEOUT_MS,
      ),
    ),
  ]);
  return result.map((a) => a.address);
}

/**
 * Throws when `url` is not an http(s) URL or resolves to a private/internal
 * address. Call before every fetch hop, including redirect targets.
 */
export async function assertSafeUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!SCHEME_RE.test(url)) {
    throw new Error("Only http/https URLs are allowed");
  }

  const hostname = parsed.hostname;
  if (isBlockedHostname(hostname)) {
    throw new Error("Access denied: private/internal addresses are blocked");
  }

  const kind = isIP(hostname);
  if (kind !== 0) {
    if (isBlockedIp(hostname)) {
      throw new Error("Access denied: private/internal addresses are blocked");
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch (err: any) {
    throw new Error(
      `Access denied: could not resolve host (${err?.message || "unknown error"})`,
    );
  }
  if (addresses.length === 0 || addresses.some(isBlockedIp)) {
    throw new Error("Access denied: private/internal addresses are blocked");
  }
}

/**
 * fetch() with SSRF protection on every hop. Redirects are followed manually
 * so each target URL is re-validated; the classic `public -> 302 -> metadata`
 * bypass doesn't work here.
 */
export async function fetchSafe(
  url: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertSafeUrl(current);
    const resp = await fetch(current, { ...init, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) return resp;
      current = new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error("Too many redirects");
}
