#!/usr/bin/env node
// Run one search from the terminal, through exactly the code path the model uses.
//
//   node bin/search.mjs --claim "The 2022 World Cup final was won by Argentina" \
//                       --query "2022 world cup final result"
//   node bin/search.mjs --json '{"claim":"…","query":"…","freshness":"month"}'
//   node bin/search.mjs --schema
//
// Same validator, same providers, same normalisation, same numbering. That matters more
// than the convenience: when a citation in a chat answer looks wrong, this is how you
// reproduce the search that produced it without a browser, a key in a browser tab, or a
// second implementation that might not have the bug.

import { search, SearchError, providerFromEnv } from "../lib/search.js";
import { SEARCH_QUERY_SCHEMA, SearchQueryError, WEB_SEARCH_TOOL } from "../lib/search-schema.js";
import { CitationLedger } from "../lib/citations.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage:
  node bin/search.mjs --claim <claim> --query <query> [options]
  node bin/search.mjs --json '<query object>'
  node bin/search.mjs --schema [--tool]

Options:
  --claim <text>       The claim being verified. Required.
  --query <text>       The search query. Required.
  --freshness <window> any | day | week | month | year   (default: any)
  --site <domain>      Restrict to one domain, e.g. reuters.com
  --max-results <n>    1-10 (default: 5)
  --json <object>      Pass the whole query as JSON instead of flags
  --schema             Print the JSON Schema for a query and exit
  --tool               With --schema, print the Gemini tool declaration instead
  --raw                Print the search result as JSON

Provider is chosen from the environment (BRAVE_SEARCH_API_KEY, TAVILY_API_KEY,
SERPER_API_KEY, GOOGLE_CSE_KEY + GOOGLE_CSE_CX, else keyless DuckDuckGo). See
web/.env.example.`;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "schema" || name === "tool" || name === "raw" || name === "help") {
      flags[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
    flags[name] = value;
    i += 1;
  }
  return flags;
}

/**
 * `.env.local` is read here but nowhere else in the app: under `node server.js` the file
 * is loaded by the server, and on Vercel the platform supplies the environment. A CLI has
 * neither, and requiring the operator to export keys by hand to reproduce a search is the
 * kind of friction that means the search doesn't get reproduced.
 */
function loadEnvFile() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of [".env.local", ".env"]) {
    try {
      const text = readFileSync(join(here, "..", name), "utf8");
      for (const line of text.split("\n")) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!match) continue;
        const value = match[2].trim().replace(/^["'](.*)["']$/, "$1");
        if (!(match[1] in process.env) && value) process.env[match[1]] = value;
      }
      return;
    } catch {
      // No such file — the next one, or the ambient environment.
    }
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (flags.schema) {
    console.log(JSON.stringify(flags.tool ? WEB_SEARCH_TOOL : SEARCH_QUERY_SCHEMA, null, 2));
    return 0;
  }

  let query;
  if (flags.json) {
    try {
      query = JSON.parse(flags.json);
    } catch (error) {
      console.error(`--json is not valid JSON: ${error.message}`);
      return 2;
    }
  } else {
    query = {
      query: flags.query,
      claim: flags.claim,
      freshness: flags.freshness,
      site: flags.site,
      max_results: flags["max-results"],
    };
    // Drop the flags that weren't passed, so the schema's own defaults apply rather than
    // `undefined` being treated as a value.
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) delete query[key];
    }
  }

  loadEnvFile();

  let provider;
  try {
    provider = providerFromEnv();
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  let result;
  try {
    result = await search(query, { provider });
  } catch (error) {
    if (error instanceof SearchQueryError) {
      console.error(`Invalid query: ${error.message}\n`);
      console.error(USAGE);
      return 2;
    }
    if (error instanceof SearchError) {
      console.error(`Search failed (${error.provider ?? "unknown provider"}): ${error.message}`);
      return 1;
    }
    throw error;
  }

  if (flags.raw) {
    console.log(JSON.stringify(result, null, 2));
    return result.results.length > 0 ? 0 : 1;
  }

  const ledger = new CitationLedger();
  const entries = ledger.record(result);

  console.log(`claim:    ${result.claim}`);
  console.log(`query:    ${result.query}${result.site ? ` (site:${result.site})` : ""}`);
  console.log(`provider: ${result.provider}   retrieved: ${result.retrievedAt}`);
  console.log("");
  if (entries.length === 0) {
    console.log("No results. This claim is not verified — that is a finding, not a failure.");
    return 1;
  }
  console.log(CitationLedger.describe(entries, result));
  return 0;
}

process.exitCode = await main();
