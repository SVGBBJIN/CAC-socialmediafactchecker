// Unit tests for public/markdown.js — the block structure of an answer. No DOM and no
// network, per the convention in CLAUDE.md: the module is deliberately pure, so what counts
// as a list item (and what nests under what) can be pinned down without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseBlocks } from "./public/markdown.js";

/** The shape of a parse, compactly: "ul[a, b]" / "para" / "ol1[…]". */
function shape(blocks) {
  return blocks
    .map((block) => {
      if (block.type !== "list") return `${block.type}(${block.text.replace(/\n/g, "\\n")})`;
      const start = block.tag === "ol" && block.start > 1 ? String(block.start) : "";
      const items = block.items
        .map((item) => (item.blocks.length ? `${item.text}>{${shape(item.blocks)}}` : item.text))
        .join(", ");
      return `${block.tag}${start}[${items}]`;
    })
    .join(" ");
}

/* ---------------------------------------------------------------- bullets */

test("a run of `-` lines is one list", () => {
  assert.equal(shape(parseBlocks("- one\n- two\n- three")), "ul[one, two, three]");
});

test("`•`, `*`, `+` and the other glyphs the model actually writes are bullets too", () => {
  for (const glyph of ["•", "*", "+", "‣", "▪", "◦"]) {
    assert.equal(shape(parseBlocks(`${glyph} one\n${glyph} two`)), "ul[one, two]", glyph);
  }
});

test("a `*emphasis*` line is prose, not a bullet", () => {
  assert.equal(shape(parseBlocks("*not a list*")), "para(*not a list*)");
});

test("an em dash opens an attribution, not a list", () => {
  assert.equal(shape(parseBlocks("— Reuters, May 2024")), "para(— Reuters, May 2024)");
});

test("a bullet needs whitespace after its marker", () => {
  assert.equal(shape(parseBlocks("-no space")), "para(-no space)");
});

/* ---------------------------------------------------------------- numbering */

test("numbered lines are an `ol`, and a list that starts at 3 says so", () => {
  assert.equal(shape(parseBlocks("1. one\n2) two")), "ol[one, two]");
  assert.equal(shape(parseBlocks("3. three\n4. four")), "ol3[three, four]");
});

test("bulleted and numbered items at the same level stay separate lists", () => {
  assert.equal(shape(parseBlocks("- a\n1. b")), "ul[a] ol[b]");
});

/* ---------------------------------------------------------------- nesting */

test("indentation nests instead of flattening", () => {
  const blocks = parseBlocks("- parent\n  - child\n  - sibling\n- back up");
  assert.equal(shape(blocks), "ul[parent>{ul[child, sibling]}, back up]");
});

test("a nested list hangs off its own parent item, not the list", () => {
  const [list] = parseBlocks("- a\n  - a1\n- b");
  assert.equal(list.items[0].blocks.length, 1);
  assert.equal(list.items[1].blocks.length, 0);
});

test("a tab indents like four spaces", () => {
  assert.equal(shape(parseBlocks("- parent\n\t- child")), "ul[parent>{ul[child]}]");
});

test("three levels nest and unwind", () => {
  const blocks = parseBlocks("- a\n  - b\n    - c\n- d");
  assert.equal(shape(blocks), "ul[a>{ul[b>{ul[c]}]}, d]");
});

test("a numbered sub-list nests under a bullet", () => {
  assert.equal(shape(parseBlocks("- a\n  1. one\n  2. two")), "ul[a>{ol[one, two]}]");
});

/* ---------------------------------------------------------------- continuation + blanks */

test("a wrapped line under a bullet belongs to that bullet", () => {
  assert.equal(shape(parseBlocks("- a claim that runs\n  past one line\n- next")), "ul[a claim that runs past one line, next]");
});

test("a blank line between items keeps one list", () => {
  assert.equal(shape(parseBlocks("- one\n\n- two")), "ul[one, two]");
});

test("a blank line then prose closes the list", () => {
  assert.equal(shape(parseBlocks("- one\n\nAfter.")), "ul[one] para(After.)");
});

test("prose before a list is its own paragraph", () => {
  assert.equal(shape(parseBlocks("Intro:\n- one")), "para(Intro:) ul[one]");
});

/* ---------------------------------------------------------------- other blocks */

test("headings carry their level", () => {
  const [block] = parseBlocks("### Sources");
  assert.deepEqual({ ...block }, { type: "heading", level: 3, text: "Sources" });
});

test("consecutive quote lines are one blockquote", () => {
  assert.equal(shape(parseBlocks("> one\n> two")), "quote(one\\ntwo)");
});

test("a fenced block keeps its body verbatim and drops the language line", () => {
  const [block] = parseBlocks("```js\nconst a = 1;\n\nconst b = 2;\n```");
  assert.equal(block.type, "code");
  assert.equal(block.text, "const a = 1;\n\nconst b = 2;");
});

test("a `- ` inside a fence is not a list", () => {
  assert.equal(shape(parseBlocks("```\n- not a bullet\n```")), "code(- not a bullet)");
});

test("an unterminated fence still closes at the end of the text", () => {
  const [block] = parseBlocks("```\nhalf");
  assert.equal(block.type, "code");
  assert.equal(block.text, "half");
});

test("a heading interrupts a list", () => {
  assert.equal(shape(parseBlocks("- one\n## Then\n- two")), "ul[one] heading(Then) ul[two]");
});

/* ---------------------------------------------------------------- edges */

test("empty and blank-only input parse to nothing", () => {
  assert.deepEqual(parseBlocks(""), []);
  assert.deepEqual(parseBlocks("\n\n  \n"), []);
  assert.deepEqual(parseBlocks(null), []);
});

test("ordinary prose is untouched, newlines and all", () => {
  assert.equal(shape(parseBlocks("One line.\nStill the same paragraph.")), "para(One line.\\nStill the same paragraph.)");
});

test("claim and timestamp markers pass through as text for the inline pass", () => {
  assert.equal(
    shape(parseBlocks("- Inflation fell [t=0:12] per the ONS [3]")),
    "ul[Inflation fell [t=0:12] per the ONS [3]]",
  );
});
