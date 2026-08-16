import { htmlToText } from "./html";
import type { Tool, ToolResult } from "./registry";
import { assertSafeUrl, fetchSafe } from "./ssrf";

export const browserTool: Tool = {
  name: "browser",
  description:
    "Open a URL in a headless browser and return the page content. Useful for JavaScript-rendered pages.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to open" },
      action: {
        type: "string",
        enum: ["get_content", "screenshot", "click", "type"],
        description: "Action to perform (default: get_content)",
      },
      selector: {
        type: "string",
        description: "CSS selector for click/type actions",
      },
      text: { type: "string", description: "Text to type" },
    },
    required: ["url"],
  },
  risk: "medium",

  async execute(input: {
    url: string;
    action?: string;
    selector?: string;
    text?: string;
  }): Promise<ToolResult> {
    // Validate before the headless browser (or the fetch fallback) ever
    // touches the URL. Playwright navigation follows redirects internally,
    // so we can't re-check every hop — but the initial target is the one the
    // prompt controls, and the fetchFallback path below is fully guarded.
    try {
      await assertSafeUrl(input.url);
    } catch (err: any) {
      return { output: err.message, isError: true };
    }

    // JSON.stringify produces a proper JS string literal, so the URL cannot
    // break out of the inline script (unlike manual quote-escaping).
    const urlLiteral = JSON.stringify(input.url);
    try {
      const proc = Bun.spawn(
        [
          "npx",
          "-y",
          "playwright",
          "evaluate",
          "--browser",
          "chromium",
          `
          const page = await context.newPage();
          await page.goto(${urlLiteral}, { waitUntil: 'networkidle', timeout: 15000 });
          const content = await page.evaluate(() => document.body.innerText);
          console.log(content.slice(0, 30000));
        `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0 || !stdout.trim()) {
        return fetchFallback(input.url);
      }

      return { output: stdout.slice(0, 30000) };
    } catch (err: any) {
      try {
        return fetchFallback(input.url);
      } catch {
        return { output: `Browser error: ${err.message}`, isError: true };
      }
    }
  },
};

// If the headless browser isn't available, fall back to a plain fetch and
// DOM-parse the result (no regex HTML mangling).
async function fetchFallback(url: string): Promise<ToolResult> {
  const resp = await fetchSafe(url, {
    headers: { "User-Agent": "Angel/1.0" },
  });
  const html = await resp.text();
  return { output: htmlToText(html).slice(0, 30000) };
}
