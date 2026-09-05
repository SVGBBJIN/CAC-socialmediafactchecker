// The block structure of an answer, as data.
//
// This is the shape half of markdown rendering — which lines are a list, which are a
// heading, where a fenced code block starts and ends — with no HTML and no DOM anywhere in
// it. The inline half (bold, code spans, `[n]` citations, `[t=…]` timestamps) stays in
// public/app.js, because it needs the source ledger and whether the pane can be seeked.
//
// Pure and DOM-free on purpose, like claims.js, timestamps.js and device.js — that is what
// lets test-markdown.js exercise it in Node with no browser, per the convention in
// CLAUDE.md.
//
// What it fixes over the inline parser it replaces:
//
//   * A `•` (or `‣`, `▪`, `◦`, `+`) bullet is a bullet. The model does not always write
//     `- `; when it wrote `• ` the line used to fall through to the paragraph branch and
//     land mid-prose as a literal glyph, with no row of its own and no indent.
//   * Indentation nests. Sub-bullets used to be flattened into their parent list, so a
//     two-level breakdown rendered as one flat column and lost the alignment that made it
//     readable.
//   * A wrapped line under a bullet belongs to that bullet. A model that hard-wraps its
//     output used to have every continuation line torn out of the list as its own
//     paragraph, which is where most of the ragged spacing came from.
//   * A blank line between two bullets no longer splits one list into two (two lists means
//     two sets of margins, i.e. a gap in the middle of what reads as one list).
//   * Consecutive `>` lines are one blockquote rather than one per line.

/** Bullet markers we accept. `*` and `+` need the trailing space to be a marker at all, so
 * a line of `*emphasis*` is never mistaken for a list. Dashes stay ASCII-only: an em dash
 * opens an attribution line (`— Reuters`) far more often than it opens a list. */
const BULLET = "[-*+•‣▪◦]";
const MARKER = new RegExp(`^(\\s*)(?:(${BULLET})|(\\d{1,9})[.)])[ \\t]+(.*)$`);
const HEADING = /^(#{1,4})\s+(.*)$/;
const QUOTE = /^>[ \t]?(.*)$/;
const FENCE = /^\s*```(.*)$/;

/** Tabs count as four columns so a tab-indented sub-bullet nests like a space-indented one. */
function indentWidth(prefix) {
  return prefix.replace(/\t/g, "    ").length;
}

/**
 * `text` → an array of blocks:
 *
 *   { type: "para",    text }
 *   { type: "heading", level, text }
 *   { type: "quote",   text }            // consecutive `>` lines, joined by newlines
 *   { type: "code",    text }            // fenced, language line stripped
 *   { type: "list",    tag, start, items: [{ text, blocks }] }
 *
 * A list item's `blocks` holds anything nested under it — in practice further lists. Every
 * `text` is raw markdown for the caller's inline pass; nothing here escapes or emits HTML.
 */
export function parseBlocks(text) {
  const lines = String(text ?? "").split("\n");
  const blocks = [];

  // Open lists, outermost first. `indent` is the column the marker sat at.
  let stack = [];
  let para = [];
  let quote = null;
  // A blank line inside a list does not close it — but a blank line followed by anything
  // that is not another item does, and the blank has to be remembered to know that.
  let blankInList = false;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push({ type: "para", text: para.join("\n") });
    para = [];
  };
  const flushQuote = () => {
    if (quote == null) return;
    blocks.push({ type: "quote", text: quote.join("\n") });
    quote = null;
  };
  /** Close open lists until only `depth` remain, folding each into its parent's last item. */
  const closeLists = (depth = 0) => {
    while (stack.length > depth) {
      const done = stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.items[parent.items.length - 1].blocks.push(done);
      else blocks.push(done);
    }
    if (stack.length === 0) blankInList = false;
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    closeLists(0);
  };
  const lastItem = () => {
    const list = stack[stack.length - 1];
    return list?.items[list.items.length - 1];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      const body = [];
      i++;
      for (; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const marker = MARKER.exec(line);
    if (marker) {
      flushPara();
      flushQuote();
      const [, prefix, bullet, number, content] = marker;
      const indent = indentWidth(prefix);
      const tag = bullet ? "ul" : "ol";

      // Anything indented further than this marker is finished.
      while (stack.length && indent < stack[stack.length - 1].indent) closeLists(stack.length - 1);

      const top = stack[stack.length - 1];
      if (!top || indent >= top.indent + 2) {
        // A first list, or one nested under the item we are sitting inside.
        stack.push({ type: "list", tag, indent, start: tag === "ol" ? Number(number) : null, items: [] });
      } else if (top.tag !== tag) {
        // Same level, different kind: a bulleted list does not silently absorb `1.` items.
        closeLists(stack.length - 1);
        stack.push({ type: "list", tag, indent, start: tag === "ol" ? Number(number) : null, items: [] });
      }
      stack[stack.length - 1].items.push({ text: content.trim(), blocks: [] });
      blankInList = false;
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      flushQuote();
      if (stack.length) blankInList = true;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushPara();
      closeLists(0);
      (quote ??= []).push(quoted[1]);
      continue;
    }
    flushQuote();

    // A non-blank, unmarked line directly under a list item is that item's own wrapped
    // text (markdown's lazy continuation) — not a new paragraph interrupting the list.
    if (stack.length && !blankInList && para.length === 0) {
      const item = lastItem();
      item.text = item.text ? `${item.text} ${line.trim()}` : line.trim();
      continue;
    }
    closeLists(0);
    para.push(line);
  }

  flushAll();
  return blocks;
}
