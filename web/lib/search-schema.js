// The shape of a search query, and the only door into the search tool.
//
// Two consumers, one definition. The model gets `WEB_SEARCH_TOOL` — a Gemini function
// declaration derived from the schema below — and the runtime puts whatever comes back
// through `validateSearchQuery` before a single byte leaves the machine. A model that
// hallucinates an argument name, or asks for fifty results, is told what it did wrong in
// a message it can act on rather than being handed a silently-corrected query.
//
// `claim` is required, and that is the load-bearing decision here. A fact-checker that
// searches for topics produces citations that are *about* the right subject and support
// nothing in particular. Making the model name the specific claim it is trying to verify
// forces the search to be an act of verification, and gives the citation ledger something
// to attach each source to.

/** JSON Schema (2020-12) for one search query. Also what the CLI validates against. */
export const SEARCH_QUERY_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://seer.local/schemas/search-query.json",
  title: "SearchQuery",
  description:
    "One web search, issued to verify one specific factual claim. Every field is chosen " +
    "by the model; nothing is inferred from the conversation.",
  type: "object",
  additionalProperties: false,
  required: ["query", "claim"],
  properties: {
    query: {
      type: "string",
      minLength: 3,
      maxLength: 300,
      description:
        "The search engine query. Keywords, names, numbers and dates — not a question " +
        "addressed to the model, and not the claim pasted verbatim.",
    },
    claim: {
      type: "string",
      minLength: 8,
      maxLength: 500,
      description:
        "The single specific claim this search is meant to verify or refute, written as " +
        "a statement. Sources found by this search are recorded against it.",
    },
    freshness: {
      type: "string",
      enum: ["any", "day", "week", "month", "year"],
      default: "any",
      description:
        "How recent a result has to be. Use 'any' for settled facts; narrow it for " +
        "breaking news, current officeholders, prices, or anything else that moves.",
    },
    site: {
      type: "string",
      maxLength: 253,
      pattern: "^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$",
      description:
        "Optional single domain to restrict the search to, e.g. 'cdc.gov' or " +
        "'reuters.com'. Use it to check a primary source, not to shop for an answer.",
    },
    max_results: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      default: 5,
      description: "How many results to return. Fewer, better sources beat more of them.",
    },
  },
};

export class SearchQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "SearchQueryError";
  }
}

/**
 * Validate and normalise one query object against `SEARCH_QUERY_SCHEMA`.
 *
 * Hand-rolled rather than pulled from npm: `web/` has no dependencies and no build step,
 * and this covers exactly the keywords the schema above uses. It fails on the first
 * problem with a message written *to the model* — the string ends up in a
 * `functionResponse`, so it is a prompt as much as an error.
 *
 * @returns a new object with defaults applied and strings trimmed.
 */
export function validateSearchQuery(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SearchQueryError("Arguments must be a JSON object matching the web_search schema.");
  }

  const properties = SEARCH_QUERY_SCHEMA.properties;

  for (const key of Object.keys(raw)) {
    if (!(key in properties)) {
      throw new SearchQueryError(
        `Unknown argument "${key}". Allowed arguments: ${Object.keys(properties).join(", ")}.`,
      );
    }
  }

  const out = {};

  for (const [key, spec] of Object.entries(properties)) {
    let value = raw[key];

    if (value === undefined || value === null || value === "") {
      if (SEARCH_QUERY_SCHEMA.required.includes(key)) {
        throw new SearchQueryError(`Argument "${key}" is required. ${spec.description}`);
      }
      if ("default" in spec) out[key] = spec.default;
      continue;
    }

    if (spec.type === "integer") {
      // Gemini sometimes sends numbers as strings; accept the digits, reject the rest.
      const parsed = typeof value === "string" ? Number(value.trim()) : value;
      if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
        throw new SearchQueryError(`Argument "${key}" must be a whole number.`);
      }
      if (parsed < spec.minimum || parsed > spec.maximum) {
        throw new SearchQueryError(
          `Argument "${key}" must be between ${spec.minimum} and ${spec.maximum}; got ${parsed}.`,
        );
      }
      out[key] = parsed;
      continue;
    }

    if (typeof value !== "string") {
      throw new SearchQueryError(`Argument "${key}" must be a string.`);
    }
    value = value.trim();

    if (spec.enum && !spec.enum.includes(value)) {
      throw new SearchQueryError(
        `Argument "${key}" must be one of: ${spec.enum.join(", ")}; got "${value}".`,
      );
    }
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      throw new SearchQueryError(
        `Argument "${key}" is too short (minimum ${spec.minLength} characters). ${spec.description}`,
      );
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      throw new SearchQueryError(
        `Argument "${key}" is too long (maximum ${spec.maxLength} characters).`,
      );
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      throw new SearchQueryError(
        `Argument "${key}" is not a bare domain name. Pass e.g. "reuters.com", with no scheme or path.`,
      );
    }

    out[key] = value;
  }

  return out;
}

/**
 * The JSON Schema above, in the subset of OpenAPI that Gemini's `functionDeclarations`
 * accepts: uppercase type names, no `$schema`/`$id`/`additionalProperties`, and none of
 * the string-length or pattern keywords (Gemini rejects a declaration containing them).
 *
 * Converted rather than written out twice, so the schema the model is shown and the
 * schema the runtime enforces cannot drift apart. The keywords dropped here are exactly
 * the ones `validateSearchQuery` still applies on the way in — the model is told about
 * them in prose, and held to them in code.
 */
export function toGeminiSchema(schema) {
  const TYPES = { object: "OBJECT", string: "STRING", integer: "INTEGER", number: "NUMBER", boolean: "BOOLEAN", array: "ARRAY" };
  const KEEP = new Set(["description", "enum", "minimum", "maximum", "format", "nullable"]);

  const convert = (node) => {
    const out = { type: TYPES[node.type] ?? "STRING" };
    for (const [key, value] of Object.entries(node)) {
      if (KEEP.has(key)) out[key] = value;
    }
    if (node.type === "object") {
      out.properties = Object.fromEntries(
        Object.entries(node.properties ?? {}).map(([k, v]) => [k, convert(v)]),
      );
      if (node.required?.length) out.required = [...node.required];
    }
    if (node.type === "array" && node.items) out.items = convert(node.items);
    return out;
  };

  return convert(schema);
}

/** What the model is handed. One tool, one job, described in terms of the citation rule. */
export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description:
    "Search the live web for sources that verify or refute one specific factual claim. " +
    "This is the only way you can learn anything about the world that is not in the " +
    "conversation itself, and every source you are allowed to cite comes from it: each " +
    "result is returned with a numbered citation marker, and only those numbers may " +
    "appear in your answer. Call it once per claim, and issue every call you need in the " +
    "same turn: calls made together are run at the same time and cost one wait between " +
    "them all, while one call per turn makes the reader sit through each search in turn. " +
    "Come back with a different query only for a claim the first results did not settle.",
  parameters: toGeminiSchema(SEARCH_QUERY_SCHEMA),
};

/** The `tools` array as `streamChat` wants it. */
export const SEARCH_TOOLS = [{ function_declarations: [WEB_SEARCH_TOOL] }];
