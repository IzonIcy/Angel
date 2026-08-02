import { parse } from "node-html-parser";

const BLOCK_TAGS = new Set([
  "script",
  "style",
  "nav",
  "header",
  "footer",
  "noscript",
  "template",
]);

/**
 * Convert raw HTML to plain text using a real DOM parser (not regex).
 *
 * This is safe where hand-rolled regexes are not: it handles `>` inside
 * quoted attribute values, nested/malformed tags, and decodes HTML entities
 * exactly once (no double-unescape, no `&amp;lt;` reintroduction).
 */
export function htmlToText(html: string): string {
  const root = parse(html);
  for (const tag of BLOCK_TAGS) {
    for (const el of root.querySelectorAll(tag)) {
      el.remove();
    }
  }
  // `.text` decodes entities and is innerText-like, unlike raw `textContent`.
  let text = root.text
    // The DOM parser decodes `&nbsp;` to a real non-breaking space; treat
    // it as an ordinary space so we don't ship invisible separators back
    // to the LLM.
    .replace(/\u00a0/g, " ")
    .trim();
  // Collapse inter-element whitespace.
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return text;
}
