import { describe, expect, test } from "bun:test";
import { assertSafeUrl, fetchSafe } from "./ssrf";

// Every SSRF bypass from the audit: alternate IP encodings, IPv4-mapped
// IPv6, userinfo tricks, non-http schemes, private ranges, localhost.
const BLOCKED_URLS = [
  "http://127.0.0.1:8080/",
  "http://localhost/",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.1/",
  "http://192.168.1.1/",
  "http://172.16.0.1/",
  "http://100.64.0.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://0177.0.0.1/",
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]:8080/",
  "http://evil.com@127.0.0.1/",
  "file:///etc/passwd",
  "ftp://example.com/",
];

describe("assertSafeUrl", () => {
  for (const url of BLOCKED_URLS) {
    test(`blocks ${url}`, async () => {
      await expect(assertSafeUrl(url)).rejects.toThrow();
    });
  }

  test("allows public URLs", async () => {
    await expect(
      assertSafeUrl("https://example.com/"),
    ).resolves.toBeUndefined();
    await expect(assertSafeUrl("http://example.com/")).resolves.toBeUndefined();
  });

  test("blocks unresolvable hosts", async () => {
    await expect(
      assertSafeUrl("http://this-host-does-not-exist-angel-test.invalid/"),
    ).rejects.toThrow();
  });
});

describe("fetchSafe", () => {
  interface MockFetch {
    calls: string[];
    restore: () => void;
  }

  // Stub global fetch so redirect chains are fully deterministic: DNS
  // lookups still hit the network, but no HTTP request ever leaves.
  function mockFetch(
    handler: (url: string, call: number) => Response,
  ): MockFetch {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: any) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(handler(url, calls.length));
    }) as typeof fetch;
    return {
      calls,
      restore: () => {
        globalThis.fetch = realFetch;
      },
    };
  }

  test("does not follow a redirect to a private address", async () => {
    const { calls, restore } = mockFetch(
      () =>
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1:80/" },
        }),
    );
    try {
      await expect(fetchSafe("https://example.com/", {}, 3)).rejects.toThrow(
        /denied/i,
      );
      // Hop 1 was fetched, hop 2 was rejected before any request went out.
      expect(calls).toEqual(["https://example.com/"]);
    } finally {
      restore();
    }
  });

  test("re-validates every redirect hop", async () => {
    const { calls, restore } = mockFetch((_url, call) => {
      if (call === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "https://example.com/next" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    try {
      const resp = await fetchSafe("https://example.com/start", {}, 3);
      expect(await resp.text()).toBe("ok");
      expect(calls).toEqual([
        "https://example.com/start",
        "https://example.com/next",
      ]);
    } finally {
      restore();
    }
  });

  test("enforces the redirect limit", async () => {
    const { calls, restore } = mockFetch(
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://example.com/" },
        }),
    );
    try {
      await expect(fetchSafe("https://example.com/", {}, 2)).rejects.toThrow(
        /redirects/i,
      );
      expect(calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      restore();
    }
  });
});
