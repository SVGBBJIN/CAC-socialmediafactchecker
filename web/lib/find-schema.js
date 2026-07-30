// The shape of a `find_in_page` call, and the only door into the page reader.
//
// Same arrangement as `search-schema.js`, and for the same reason: one schema, converted
// for the model and enforced on the way in, so a hallucinated argument gets a message the
// model can act on rather than a silently-corrected call.
//
// The load-bearing constraint here is `url`. It must be a URL some search already returned
// this turn, and the runtime checks that against the citation ledger rather than trusting
// it. Letting the model name any URL would put a page in front of it that nothing
// retrieved — an unnumbered source with no entry in the ledger, quotable and uncitable at
// the same time, which is precisely the hole the ledger exists to close. Search first, then
// read what the search found.

import { toGeminiSchema, WEB_SEARCH_TOOL } from "./search-schema.js";

/** JSON Schema (2020-12) for one in-page find. */
export const FIND_IN_PAGE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://seer.local/schemas/find-in-page.json",
  title: "FindInPage",
  description:
    "Open one page a search already returned and pull out the passages that address one " +
    "specific claim, matched by meaning as well as by wording.",
  type: "object",
  additionalProperties: false,
  required: ["url", "find", "claim"],
  properties: {
    url: {
      type: "string",
      maxLength: 2_000,
      description:
        "The full URL of a page returned by a web_search this turn. Copy it exactly from " +
        "the search result; a URL no search returned will be refused.",
    },
    find: {
      type: "string",
      minLength: 3,
      maxLength: 300,
      description:
        "What to look for on the page, in your own words — the wording is matched by " +
        "meaning, so a plain description of the fact you need works better than keywords. " +
        "Where the claim turns on an exact figure, quote or name, include it verbatim: an " +
        "exact hit outranks every paraphrase.",
    },
    claim: {
      type: "string",
      minLength: 8,
      maxLength: 500,
      description:
        "The single specific claim this find is meant to verify or refute, written as a " +
        "statement. Recorded against the source, like a search's claim.",
    },
    max_passages: {
      type: "integer",
      minimum: 1,
      maximum: 8,
      default: 4,
      description: "How many passages to return. Three or four is almost always enough.",
    },
  },
};

export class FindQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "FindQueryError";
  }
}

/**
 * Validate and normalise one find call.
 *
 * Hand-rolled for the same reason as `validateSearchQuery`: no dependencies, and error
 * messages written to be read by the model, since they end up in a `functionResponse`.
 *
 * @returns a new object with defaults applied, strings trimmed, and `url` normalised.
 */
export function validateFindQuery(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FindQueryError("Arguments must be a JSON object matching the find_in_page schema.");
  }

  const properties = FIND_IN_PAGE_SCHEMA.properties;
  for (const key of Object.keys(raw)) {
    if (!(key in properties)) {
      throw new FindQueryError(
        `Unknown argument "${key}". Allowed arguments: ${Object.keys(properties).join(", ")}.`,
      );
    }
  }

  const out = {};
  for (const [key, spec] of Object.entries(properties)) {
    const value = raw[key];

    if (value === undefined || value === null || value === "") {
      if (FIND_IN_PAGE_SCHEMA.required.includes(key)) {
        throw new FindQueryError(`Argument "${key}" is required. ${spec.description}`);
      }
      if ("default" in spec) out[key] = spec.default;
      continue;
    }

    if (spec.type === "integer") {
      const parsed = typeof value === "string" ? Number(value.trim()) : value;
      if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
        throw new FindQueryError(`Argument "${key}" must be a whole number.`);
      }
      if (parsed < spec.minimum || parsed > spec.maximum) {
        throw new FindQueryError(
          `Argument "${key}" must be between ${spec.minimum} and ${spec.maximum}; got ${parsed}.`,
        );
      }
      out[key] = parsed;
      continue;
    }

    if (typeof value !== "string") {
      throw new FindQueryError(`Argument "${key}" must be a string.`);
    }
    const trimmed = value.trim();
    if (spec.minLength !== undefined && trimmed.length < spec.minLength) {
      throw new FindQueryError(
        `Argument "${key}" is too short (minimum ${spec.minLength} characters). ${spec.description}`,
      );
    }
    if (spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
      throw new FindQueryError(`Argument "${key}" is too long (maximum ${spec.maxLength} characters).`);
    }
    out[key] = trimmed;
  }

  if (!/^https?:\/\/\S+$/i.test(out.url)) {
    throw new FindQueryError(
      `"${out.url}" is not an http(s) URL. Pass the full URL of a page a web_search returned.`,
    );
  }

  return out;
}

/** What the model is handed. */
export const FIND_IN_PAGE_TOOL = {
  name: "find_in_page",
  description:
    "Ctrl+F, but by meaning as well as by wording: open a page a web_search already " +
    "returned and get back the exact passages that speak to one claim. Use it whenever a " +
    "search snippet is suggestive but not conclusive — a snippet is a fragment an engine " +
    "chose for a different purpose, and the sentence that actually settles the claim, with " +
    "its figure and its caveats, is on the page. One find on the right source beats three " +
    "more searches, and it lets you quote the source instead of paraphrasing its snippet. " +
    "The URL must come from a search result in this conversation. Issue every find you " +
    "need in the same turn so they run at once.",
  parameters: toGeminiSchema(FIND_IN_PAGE_SCHEMA),
};

/**
 * Both research tools, in one declaration group, as `streamChat` wants them.
 *
 * Declared together rather than in stages because they are used together in one round: the
 * model searches for several claims, and on the same evidence reads the two pages worth
 * reading. Handing it the reader only after the searches have come back would cost a round
 * per page, and rounds are what the reader waits through.
 */
export const RESEARCH_TOOLS = [{ function_declarations: [WEB_SEARCH_TOOL, FIND_IN_PAGE_TOOL] }];
