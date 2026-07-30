#!/usr/bin/env node
// Run one in-page find from the terminal, through exactly the code path the model uses.
//
//   node bin/find.mjs --url https://www.cdc.gov/measles/cases.html \
//                     --find "how many cases were reported in 2026"
//   node bin/find.mjs --url <url> --find "…" --show-scores
//   node bin/find.mjs --url <url> --find "…" --lexical    # no embeddings
//
// This exists for one reason: a ranking is the hardest kind of bug to see from a chat
// answer. When a fact-check misses a figure that is plainly on the page, the question is
// whether the fetch dropped the text, the splitter cut the sentence in half, the lexical
// half scored it below the floor, or the semantic half was quietly unavailable — and from
// the outside all four look identical. `--show-scores` separates them: it prints both
// halves of every passage's score, so the failure names itself.
//
// Same fetch, same extraction, same scoring, same floor as the tool. Not a second
// implementation that might not have the bug.

import { fetchPage, extractPassages, rankPassages } from "../lib/page-find.js";
import { PageFindError } from "../lib/page-find.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage:
  node bin/find.mjs --url <url> --find <what to look for> [options]

Options:
  --url <url>        The page to read. Required.
  --find <text>      What to look for, in plain words. Required.
  --max <n>          How many passages to return, 1-8 (default: 4)
  --lexical          Skip the semantic half, even if a Gemini key is present
  --show-scores      Print the lexical and semantic halves of each score
  --passages         Print every passage the splitter produced, and exit
  --raw              Print the result as JSON

The semantic half needs GEMINI_API_KEY (read from web/.env.local, like the server). Without
it the find still works on fuzzy lexical matching alone, which is what a deployment with no
key runs in — worth checking with --lexical when a result looks wrong.`;

function parseArgs(argv) {
  const args = { max: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${flag} needs a value.`);
      }
      i += 1;
      return value;
    };
    switch (flag) {
      case "--url": args.url = next(); break;
      case "--find": args.find = next(); break;
      case "--max": args.max = Number(next()); break;
      case "--lexical": args.lexical = true; break;
      case "--show-scores": args.showScores = true; break;
      case "--passages": args.listPassages = true; break;
      case "--raw": args.raw = true; break;
      case "-h":
      case "--help": console.log(USAGE); process.exit(0); break;
      default: fail(`Unknown option: ${flag}`);
    }
  }
  return args;
}

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

/** The same .env.local the dev server reads, so the two agree about the key. */
function loadEnvLocal() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of [".env.local", ".env"]) {
    try {
      const body = readFileSync(join(here, "..", name), "utf8");
      for (const line of body.split("\n")) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        const value = match[2].trim().replace(/^["']|["']$/g, "");
        if (value && !(match[1] in process.env)) process.env[match[1]] = value;
      }
    } catch {
      // Absent is fine — the lexical half needs no key at all.
    }
  }
}

loadEnvLocal();
const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.find) fail("Both --url and --find are required.");

const apiKey = args.lexical ? null : process.env.GEMINI_API_KEY;

try {
  const page = await fetchPage(args.url);
  const passages = extractPassages(page.text);

  if (args.listPassages) {
    console.log(`${passages.length} passages from ${page.title || args.url}\n`);
    for (const passage of passages) {
      console.log(`#${passage.index} (${passage.text.length} chars)\n  ${passage.text}\n`);
    }
    process.exit(0);
  }

  const result = await rankPassages(args.find, passages, {
    apiKey,
    limit: Math.max(1, Math.min(8, args.max || 4)),
  });

  if (args.raw) {
    console.log(JSON.stringify({ title: page.title, passageCount: passages.length, ...result }, null, 2));
    process.exit(0);
  }

  console.log(`${page.title || args.url}`);
  console.log(
    `${passages.length} passages read · ranked by ${
      result.semantic ? "meaning and wording" : "wording only (no semantic half)"
    } · looking for “${args.find}”`,
  );
  if (!result.semantic && !args.lexical && apiKey) {
    // The one failure worth calling out explicitly: a key is set, the embedding call failed
    // anyway, and the ranking silently halved. From a chat answer this is invisible.
    console.log("note: a Gemini key is set but the embedding call did not succeed.");
  }
  console.log("");

  if (result.passages.length === 0) {
    console.log("Nothing on this page matches. That is a finding about the page, not an error.");
    console.log(`(terms searched: ${result.terms.join(", ") || "none"})`);
    process.exit(0);
  }

  for (const [index, passage] of result.passages.entries()) {
    const detail = args.showScores
      ? ` lexical ${passage.lexical} · semantic ${passage.semantic ?? "—"}${passage.phrase ? " · exact phrase" : ""} · matched ${passage.matched.join(", ") || "—"}`
      : passage.phrase
        ? " · exact phrase"
        : "";
    console.log(`${index + 1}. [${passage.score}]${detail}`);
    console.log(`   “${passage.text}”\n`);
  }
} catch (error) {
  if (error instanceof PageFindError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
