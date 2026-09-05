// YouTube → the post's own title, for the video pane's "open original" link.
//
// Unlike TikTok/Instagram, YouTube costs the fact-check nothing: `toGeminiContents`
// (lib/gemini.js) hands Gemini the watch URL as a `file_data` part and it fetches the video
// itself, and the video pane embeds it client-side from a bare video ID — no bytes, no
// resolve step, ever touch this app for the video itself. But that also means nothing here
// ever learns the post's *title*, so the pane fell back to showing the pasted URL where
// TikTok/Instagram show the real thing (see `applyPostTitle`/`loadDirectMedia` in
// public/app.js). This module is the one-field fix: YouTube's oEmbed endpoint answers an
// anonymous request with the title and channel name (no video, same as TikTok's), which is
// all the pane needs.

import { fetchWithTimeout } from "./media-fetch.js";

/** Longest we'll wait for oEmbed before the pane just keeps showing the pasted URL. */
export const OEMBED_TIMEOUT_MS = 8_000;

const OEMBED_ENDPOINT = "https://www.youtube.com/oembed";

/**
 * Mirrors `isYouTubeHost` in lib/gemini.js (not exported there, so restated rather than
 * imported): strips a leading `www.`/`m.`/etc. subdomain so `m.youtube.com` and
 * `youtube.com` agree, and accepts regional subdomains.
 */
export function isYouTubeHost(hostname) {
  const bare = hostname.toLowerCase().replace(/^(www|m|mobile|vm|vt)\./, "");
  return (
    bare === "youtube.com" ||
    bare === "youtu.be" ||
    bare === "youtube-nocookie.com" ||
    bare.endsWith(".youtube.com")
  );
}

/**
 * YouTube's oEmbed response for a watch/shorts/youtu.be URL — title and channel name, no
 * video (it returns an `<iframe>` embed we don't need; the pane already builds its own).
 *
 * Best-effort, like `fetchTikTokOEmbed`: returns `null` on any failure rather than
 * throwing, since a title fetched a moment late (or not at all) still leaves the pane with
 * the pasted URL to fall back on.
 */
export async function fetchYouTubeOEmbed(urlString, { fetchImpl = fetch, signal, timeoutMs = OEMBED_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchWithTimeout(`${OEMBED_ENDPOINT}?url=${encodeURIComponent(urlString)}&format=json`, {
      fetchImpl,
      signal,
      timeoutMs,
      headers: { accept: "application/json" },
      credentials: "omit",
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let json;
  try {
    json = await response.json();
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;

  const title = typeof json.title === "string" && json.title.trim() ? json.title.trim() : null;
  const authorName =
    typeof json.author_name === "string" && json.author_name.trim() ? json.author_name.trim() : null;
  if (!title && !authorName) return null;

  return { title, authorName };
}
