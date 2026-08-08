// Live tracking for the searches and reads one turn dispatches — split out of app.js so the
// one thing worth getting exactly right here (matching a completion frame back to the chip
// it belongs to) can be pinned down without a DOM, the same convention claims.js and
// timestamps.js follow for their own parsing logic. Rendering the tracked items as HTML
// stays in app.js, which is where `escapeHTML` and the DOM already live.
//
// The server announces a round's calls before any of them has an answer — the
// `{type: "searching"}` frame documented on `verifiedChat` in lib/verified-chat.js — so the
// reader isn't staring at a static "Reading the sources" label for however long the round's
// slowest search takes with nothing to show for it. This module turns that announcement,
// plus the `search`/`find` frames that land later, into one item per call with a status that
// updates in place.
//
// Matching a later result back to the chip it belongs to is the part worth documenting.
// `streamChat`'s tool loop (lib/gemini.js) resolves a round's calls and yields their frames
// strictly in dispatch order, so the *n*th `search` frame in a round always answers the
// *n*th `web_search` call that round announced — and likewise for `find`. Two FIFO queues,
// one per tool, is what that guarantees turn into: a completion frame of a given type always
// resolves the oldest still-pending item of that same type, regardless of how the two tools
// were interleaved in the actual call order, and regardless of which one happened to finish
// first (see SEARCH_STRAGGLER_MS in lib/verified-chat.js — a dropped straggler resolves to
// `error` the same way a genuine failure does). Rounds never overlap — a round's calls are
// all awaited before the next one is dispatched — so nothing here needs to know which round
// an item belongs to.

/** How many of the tracked items are worth showing at once — see `visibleItems`. */
export const MAX_VISIBLE_RESEARCH_CHIPS = 4;

export function createResearchTracker() {
  let items = [];
  let searchQueue = [];
  let findQueue = [];
  let nextId = 0;

  function push(kind, label) {
    const item = {
      id: nextId++,
      kind,
      label: label || (kind === "find" ? "reading…" : "searching…"),
      status: "pending",
    };
    items.push(item);
    (kind === "search" ? searchQueue : findQueue).push(item);
    return item;
  }

  // A no-op rather than a throw when the queue is already empty: a completion frame with
  // nothing pending to match it is not a bug in this module, it's a caller running the
  // tracker against a stream it didn't reset (or a test poking it directly) — either way,
  // silently doing nothing is safer than corrupting `items` or crashing the render loop
  // that called it.
  function settle(queue, status) {
    const item = queue.shift();
    if (item) item.status = status;
    return item ?? null;
  }

  return {
    /** Drops everything tracked — called at the start of each turn, the same way the clip
     * and article caches reset per request rather than accumulating across them. */
    reset() {
      items = [];
      searchQueue = [];
      findQueue = [];
    },
    /** One `{type: "searching"}` frame — `searches` and `reads` are this round's calls,
     * each becoming one pending item in the order they arrived in. */
    onSearching(frame) {
      for (const s of frame?.searches ?? []) push("search", s?.query);
      for (const r of frame?.reads ?? []) push("find", r?.find || r?.url);
    },
    /** One `{type: "search"}` frame — resolves the oldest pending search to `done`, or
     * `error` when the frame carries one (a real failure, or a straggler cut off after
     * SEARCH_STRAGGLER_MS — both arrive the same shape here). */
    onSearch(frame) {
      return settle(searchQueue, frame?.error ? "error" : "done");
    },
    /** One `{type: "find"}` frame — same resolution, against the read queue. */
    onFind(frame) {
      return settle(findQueue, frame?.error ? "error" : "done");
    },
    /** A live view — mutated in place by the calls above, not a snapshot. Callers that need
     * a bounded, render-ready slice want `visibleItems` instead. */
    get items() {
      return items;
    },
  };
}

/**
 * The tail of a tracker's items, bounded to `max`.
 *
 * Dispatch order, not most-recent-first: reversing it would make a rendered row reshuffle
 * every time a new item arrives, when what actually changed is which end grew. Bounding to
 * the tail is what keeps a long, multi-round turn from growing an ever-longer row instead —
 * an early round's items have already told their story by the time a later one is running.
 */
export function visibleItems(tracker, max = MAX_VISIBLE_RESEARCH_CHIPS) {
  return max > 0 ? tracker.items.slice(-max) : [];
}
