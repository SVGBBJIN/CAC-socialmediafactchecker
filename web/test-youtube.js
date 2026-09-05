// lib/youtube.js — the video pane's YouTube title fetch (see api/resolve-media.js's
// `kind: "title"` branch and public/app.js's `loadYouTubeTitle`). No network: every case
// hands in a stub `fetchImpl`, same convention as test.js's TikTok oEmbed tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchYouTubeOEmbed, isYouTubeHost } from "./lib/youtube.js";

const WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

test("isYouTubeHost accepts youtube.com, youtu.be, youtube-nocookie.com and their subdomains", () => {
  assert.ok(isYouTubeHost("youtube.com"));
  assert.ok(isYouTubeHost("www.youtube.com"));
  assert.ok(isYouTubeHost("m.youtube.com"));
  assert.ok(isYouTubeHost("music.youtube.com"));
  assert.ok(isYouTubeHost("youtu.be"));
  assert.ok(isYouTubeHost("youtube-nocookie.com"));
  assert.ok(!isYouTubeHost("youtube.com.evil.example"));
  assert.ok(!isYouTubeHost("notyoutube.com"));
});

test("oEmbed reads title and channel name from YouTube's real endpoint", async () => {
  let seenURL;
  const fetchImpl = async (url) => {
    seenURL = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        title: "Rick Astley - Never Gonna Give You Up",
        author_name: "Rick Astley",
      }),
    };
  };
  const meta = await fetchYouTubeOEmbed(WATCH_URL, { fetchImpl });
  assert.deepEqual(meta, { title: "Rick Astley - Never Gonna Give You Up", authorName: "Rick Astley" });
  assert.ok(seenURL.startsWith("https://www.youtube.com/oembed?url="));
  assert.ok(seenURL.includes(encodeURIComponent(WATCH_URL)));
  assert.ok(seenURL.endsWith("&format=json"));
});

test("oEmbed is best-effort — a failure returns null instead of throwing", async () => {
  assert.equal(await fetchYouTubeOEmbed(WATCH_URL, { fetchImpl: async () => ({ ok: false, status: 404 }) }), null);
  assert.equal(
    await fetchYouTubeOEmbed(WATCH_URL, {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    }),
    null,
  );
  assert.equal(
    await fetchYouTubeOEmbed(WATCH_URL, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    }),
    null,
    "an empty body carries nothing worth keeping",
  );
});

test("a title with no channel name still resolves, and vice versa", async () => {
  const titleOnly = await fetchYouTubeOEmbed(WATCH_URL, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ title: "Just a title" }) }),
  });
  assert.deepEqual(titleOnly, { title: "Just a title", authorName: null });

  const authorOnly = await fetchYouTubeOEmbed(WATCH_URL, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ author_name: "Some Channel" }) }),
  });
  assert.deepEqual(authorOnly, { title: null, authorName: "Some Channel" });
});
