import { parse } from "node-html-parser";
import { htmlToText } from "./html";
import type { Tool, ToolResult } from "./registry";
import { fetchSafe } from "./ssrf";

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web for information. Returns relevant search results with snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: {
        type: "number",
        description: "Maximum results (default: 5)",
      },
    },
    required: ["query"],
  },
  risk: "low",

  async execute(input: {
    query: string;
    max_results?: number;
  }): Promise<ToolResult> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Angel/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      const html = await resp.text();
      const results: string[] = [];

      // Parse once, then query the DOM. Selecting real elements (instead of
      // regex-hopping through raw HTML) is robust against `>` in quoted
      // attributes and malformed markup, and `.text` decodes entities.
      const root = parse(html);
      const anchors = root.querySelectorAll("a.result__a");
      const snippetEls = root.querySelectorAll("a.result__snippet");

      const max = input.max_results || 5;
      let i = 0;
      for (const anchor of anchors) {
        if (i >= max) break;
        const href = anchor.getAttribute("href") ?? "";
        // Snippets are siblings of the result link and appear in document
        // order, so pairing by index mirrors the original intent without
        // regex. `.text` already decodes HTML entities.
        const title = anchor.text.trim();
        const snippet = snippetEls[i] ? snippetEls[i].text.trim() : "";
        results.push(`[${i + 1}] ${title}\n    ${href}\n    ${snippet}`);
        i++;
      }

      return {
        output: results.length > 0 ? results.join("\n\n") : "No results found",
      };
    } catch (err: any) {
      return { output: `Search error: ${err.message}`, isError: true };
    }
  },
};

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch a web page and return its text content (HTML stripped).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      max_length: {
        type: "number",
        description: "Max characters to return (default: 20000)",
      },
    },
    required: ["url"],
  },
  risk: "low",

  async execute(input: {
    url: string;
    max_length?: number;
  }): Promise<ToolResult> {
    const maxLen = input.max_length || 20000;
    try {
      const resp = await fetchSafe(input.url, {
        headers: { "User-Agent": "Angel/1.0" },
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        return {
          output: `HTTP ${resp.status}: ${resp.statusText}`,
          isError: true,
        };
      }

      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await resp.json();
        return { output: JSON.stringify(json, null, 2).slice(0, maxLen) };
      }

      const html = await resp.text();
      const text = htmlToText(html);
      return { output: text.slice(0, maxLen) };
    } catch (err: any) {
      return { output: `Fetch error: ${err.message}`, isError: true };
    }
  },
};

export const webTools = [webSearchTool, webFetchTool];
