// node --test test-timestamps.js
//
// Where in the clip a claim was made. Three things are under test, and they are the three
// ways this feature could be worse than not having it:
//
//   - **A marker that cannot be true is deleted.** A timestamp past the end of the clip
//     names a moment that does not exist, and it looks exactly as checkable as one that
//     does.
//   - **Every other marker survives untouched.** This pass rewrites the reader's answer.
//     A correct timestamp deleted, or a sentence altered around one, is a worse failure
//     than the wrong timestamp it was trying to catch.
//   - **The turn knows which clips it is about.** A marker is only a link because the
//     server said which video was attached, so the frame that says so has to go out — once
//     per video, before the answer, and never for a clip that was not attached.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseClock,
  formatClock,
  videoLinkAt,
  knownDuration,
  cleanTimestamps,
  END_TOLERANCE_SECONDS,
} from "./lib/timestamps.js";
import { toGeminiContents, streamChat } from "./lib/gemini.js";
import { verifiedChat } from "./lib/verified-chat.js";

const youtube = { platform: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoID: "dQw4w9WgXcQ", duration: null };
const tikTok = { platform: "tiktok", url: "https://www.tiktok.com/@a/video/123", videoID: "123", duration: 45 };

/* ---------------- reading and writing a clock ---------------- */

test("a marker parses to seconds in both the short and the long form", () => {
  assert.equal(parseClock("[0:42]"), 42);
  assert.equal(parseClock("[12:07]"), 727);
  assert.equal(parseClock("[1:02:33]"), 3753);
  // Bare, as the caller may hand it over without its brackets.
  assert.equal(parseClock("2:00"), 120);
});

test("anything that is not a clock is not read as one", () => {
  // The failure this guards is a silent zero: a `null` renders as text, a 0 sends the
  // reader to the start of the video and tells them the claim was made there.
  for (const input of ["[42]", "[1:2]", "[1:60]", "[]", "twelve", "", null]) {
    assert.equal(parseClock(input), null, `${JSON.stringify(input)} should not parse`);
  }
});

test("seconds format back to the shortest correct clock", () => {
  assert.equal(formatClock(42), "0:42");
  assert.equal(formatClock(727), "12:07");
  assert.equal(formatClock(3753), "1:02:33");
  assert.equal(formatClock(0), "0:00");
});

/* ---------------- what a timestamp can be turned into ---------------- */

test("a YouTube timestamp becomes a link that opens the video at that second", () => {
  assert.equal(
    videoLinkAt(youtube, 42),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
  );
});

test("a TikTok timestamp has no link, and does not get given a wrong one", () => {
  // The temptation is `?t=42` — TikTok ignores it, the clip starts from the beginning, and
  // on a forty-second video the reader never notices the link did nothing.
  assert.equal(videoLinkAt(tikTok, 20), null);
  assert.equal(videoLinkAt(null, 20), null);
  assert.equal(videoLinkAt(youtube, Number.NaN), null);
});

/* ---------------- the bound, and what it is taken from ---------------- */

test("the bound is the longest clip whose length is known, or nothing", () => {
  assert.equal(knownDuration([tikTok]), 45);
  assert.equal(knownDuration([tikTok, { ...tikTok, duration: 90 }]), 90);
  // YouTube never reports one, so a turn about a YouTube video is unbounded — and this is
  // what makes that explicit rather than accidental.
  assert.equal(knownDuration([youtube]), null);
  assert.equal(knownDuration([]), null);
});

test("a marker past the end of the clip is deleted; the sentence around it is not", () => {
  const answer = "The clip claims measles tripled [3:20]. That is wrong [1].";
  const cleaned = cleanTimestamps(answer, [tikTok]);
  assert.equal(cleaned.text, "The clip claims measles tripled. That is wrong [1].");
  assert.equal(cleaned.dropped, 1);
  assert.equal(cleaned.changed, true);
  // The citation is a different marker and is none of this pass's business.
  assert.match(cleaned.text, /\[1\]/);
});

test("a marker just past the stated duration is believed, not deleted", () => {
  // Gemini reads video at about a frame a second and rounds; so does TikTok's own duration.
  // Enforcing the boundary to the second would delete correct markers at the end of a clip.
  const withinSlack = cleanTimestamps("Said at the very end [0:46].", [tikTok]);
  assert.equal(withinSlack.dropped, 0);
  assert.equal(withinSlack.text, "Said at the very end [0:46].");
  assert.ok(END_TOLERANCE_SECONDS >= 1);
});

test("markers inside the clip are kept and reported in the order they appear", () => {
  const cleaned = cleanTimestamps("First [0:03], then [0:31].", [tikTok]);
  assert.equal(cleaned.changed, false);
  assert.deepEqual(
    cleaned.stamps.map((s) => s.seconds),
    [3, 31],
  );
});

test("with no clip length known, nothing is deleted", () => {
  // A YouTube turn, which is most of them. The marker cannot be checked, so it is left
  // exactly as written — the link it becomes lands in the video the reader already has open,
  // and deleting on a suspicion is the guesswork this codebase removed from the citation path.
  const answer = "The claim is made at [1:04:10] and it is false [2].";
  const cleaned = cleanTimestamps(answer, [youtube]);
  assert.equal(cleaned.changed, false);
  assert.equal(cleaned.text, answer);
  assert.equal(cleaned.stamps.length, 1);
});

test("a turn with no video at all leaves the text alone", () => {
  // Nothing here is a claim about a clip — it is a scoreline and a Bible verse — and this
  // pass has no business touching either.
  const answer = "The score was [2:1] at half time.";
  assert.equal(cleanTimestamps(answer, []).text, answer);
  assert.equal(cleanTimestamps(answer, []).changed, false);
});

test("a slice in a code sample is not a timestamp", () => {
  const answer = "Use `frames[1:30]` to take the window.\n\n```py\nrows[9:99]\n```";
  const cleaned = cleanTimestamps(answer, [tikTok]);
  assert.equal(cleaned.text, answer);
  assert.equal(cleaned.dropped, 0);
  assert.equal(cleaned.stamps.length, 0);
});

test("deleting a marker leaves the prose reading as though it was never typed", () => {
  const cleaned = cleanTimestamps("They say it [9:59] , and repeat it [8:00] later.", [tikTok]);
  assert.equal(cleaned.text, "They say it, and repeat it later.");
  assert.equal(cleaned.dropped, 2);
});

/* ---------------- telling the reader which clip it is ---------------- */

test("each attached video is reported once, with what is known about its length", () => {
  const attached = [];
  toGeminiContents(
    [
      { role: "user", content: "check https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      { role: "assistant", content: "Looking at https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      { role: "user", content: "and again https://youtu.be/dQw4w9WgXcQ" },
    ],
    { onAttach: (video) => attached.push(video) },
  );

  // Once, at first mention — the same rule the media itself follows, and for the same
  // reason: the second mention is not a second video.
  assert.deepEqual(attached, [
    {
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      videoID: "dQw4w9WgXcQ",
      duration: null,
    },
  ]);
});

test("a TikTok is reported with the duration its embed page gave", () => {
  const attached = [];
  const link = "https://www.tiktok.com/@user/video/7300000000000000000";
  toGeminiContents([{ role: "user", content: `check ${link}` }], {
    tikTok: {
      attachments: new Map([
        [
          link,
          {
            videoID: "7300000000000000000",
            resolved: { sourceURL: link, videoID: "7300000000000000000", duration: 45.2 },
            part: { inline_data: { mime_type: "video/mp4", data: "AA==" } },
          },
        ],
      ]),
    },
    onAttach: (video) => attached.push(video),
  });

  assert.deepEqual(attached, [
    { platform: "tiktok", url: link, videoID: "7300000000000000000", duration: 45.2 },
  ]);
});

test("a clip that could not be fetched is never reported as attached", () => {
  const attached = [];
  const link = "https://www.tiktok.com/@user/video/7300000000000000000";
  toGeminiContents([{ role: "user", content: `check ${link}` }], {
    tikTok: { attachments: new Map([[link, { error: "the video is private" }]]) },
    onAttach: (video) => attached.push(video),
  });
  assert.deepEqual(attached, []);
});

test("the turn announces its video before the model says anything about it", async () => {
  const chunks = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "It is said at [0:12]." }] } }] })}\n\n`,
  ];
  const frames = [];
  for await (const frame of streamChat({
    apiKey: "k",
    messages: [{ role: "user", content: "check https://www.youtube.com/watch?v=dQw4w9WgXcQ" }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        const encoder = new TextEncoder();
        for (const chunk of chunks) yield encoder.encode(chunk);
      })(),
    }),
  })) {
    frames.push(frame);
  }

  const video = frames.find((f) => f.type === "video");
  assert.ok(video, "a video frame should be sent");
  assert.deepEqual(video.videos, [
    {
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      videoID: "dQw4w9WgXcQ",
      duration: null,
    },
  ]);
  // Before the first token, so a marker is a link the moment it is written rather than
  // after the stream ends.
  assert.ok(
    frames.indexOf(video) < frames.findIndex((f) => f.type === "delta"),
    "the video frame must precede the answer",
  );
});

/* ---------------- the whole turn ---------------- */

/** A Gemini that answers once with `text`, and a TikTok that resolves without a network. */
function fakeClipTurn(text, { duration = 45, env = {} } = {}) {
  const link = "https://www.tiktok.com/@user/video/7300000000000000000";
  return {
    link,
    options: {
      apiKey: "k",
      messages: [{ role: "user", content: `check ${link}` }],
      env,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: (async function* () {
          yield new TextEncoder().encode(
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`,
          );
        })(),
      }),
      searchImpl: async () => {
        throw new Error("no search should be needed for this turn");
      },
      tikTokOptions: {
        resolveImpl: async () => ({
          sourceURL: link,
          videoID: "7300000000000000000",
          duration,
          caption: null,
          authorName: "user",
        }),
        downloadImpl: async () => ({ bytes: Buffer.from("mp4"), mimeType: "video/mp4" }),
      },
    },
  };
}

test("a timestamp past the end of the clip never reaches the reader", async () => {
  // The end-to-end version of the deletion rule, through the layer that actually applies
  // it: the model wrote the marker, the stream carried it, and the reader's copy has it
  // gone. Deliberately a turn that cites nothing — the cleanup used to run only when a
  // search had happened, and a video answer with no sources is exactly the turn that
  // timestamps matter most in.
  const { options } = fakeClipTurn("The clip claims measles tripled [3:20]. I could not check it.");
  const frames = [];
  for await (const frame of verifiedChat(options)) frames.push(frame);

  const video = frames.find((f) => f.type === "video");
  assert.equal(video.videos[0].duration, 45);

  const answer = frames.find((f) => f.type === "answer");
  assert.ok(answer, "the corrected answer should be sent as a replacement");
  assert.equal(answer.text, "The clip claims measles tripled. I could not check it.");
});

test("a timestamp inside the clip is left exactly as the model wrote it", async () => {
  const { options } = fakeClipTurn("The clip claims measles tripled [0:20]. I could not check it.");
  const frames = [];
  for await (const frame of verifiedChat(options)) frames.push(frame);

  // No `answer` frame at all: nothing was changed, so nothing is redrawn.
  assert.equal(frames.some((f) => f.type === "answer"), false);
  const shown = frames.filter((f) => f.type === "delta").map((f) => f.text).join("");
  assert.equal(shown, "The clip claims measles tripled [0:20]. I could not check it.");
});

test("the check runs even with the research tools switched off", async () => {
  // A deployment with WEB_SEARCH_ENABLED=false still watches videos, and a timestamp is a
  // claim about the clip rather than about anything a search returned. This turn used to
  // return before the cleanup ran, and the impossible marker reached the reader.
  const { options } = fakeClipTurn("The clip claims measles tripled [3:20].", {
    env: { WEB_SEARCH_ENABLED: "false" },
  });
  const frames = [];
  for await (const frame of verifiedChat(options)) frames.push(frame);

  const answer = frames.find((f) => f.type === "answer");
  assert.equal(answer.text, "The clip claims measles tripled.");
});

test("a turn with no video sends no video frame", async () => {
  const frames = [];
  for await (const frame of streamChat({
    apiKey: "k",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello." }] } }] })}\n\n`,
        );
      })(),
    }),
  })) {
    frames.push(frame);
  }
  assert.equal(frames.some((f) => f.type === "video"), false);
});
