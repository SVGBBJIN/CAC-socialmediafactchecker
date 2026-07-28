# Spike: does Instagram behave like TikTok?

**Date:** 2026-07-27
**Question asked:** before building the Instagram method, confirm its oEmbed endpoint
returns embeddable HTML the way TikTok's does.
**Answer: no. Instagram does not behave like TikTok, and the difference is a business
blocker, not a code one.**

Do not build the Instagram extractor against an assumption that it mirrors TikTok. The
code is written and tested (`CaptureBasedExtractor.instagram`), but it cannot be
registered until someone obtains a Meta app token — see *What unblocks it* below.

## What was tested

### 1. TikTok — the baseline (works)

```
GET https://www.tiktok.com/oembed?url=https://www.tiktok.com/@scout2015/video/6718335390845095173
→ 200 OK
```

Returns JSON with `html` (a `blockquote.tiktok-embed` plus a `<script src=".../embed.js">`),
`author_name`, `title`, `thumbnail_url`. **No credential of any kind.** The live response
is checked into `Tests/SeerCoreTests/CapturePipelineTests.swift` as a fixture.

### 2. Instagram legacy oEmbed — dead

```
GET https://api.instagram.com/oembed?url=https://www.instagram.com/p/<shortcode>/
→ 500
```

The token-free endpoint that most tutorials still reference was retired and now returns
a server error. It is not an option.

### 3. Instagram Graph oEmbed — exists, but gated

```
GET https://graph.facebook.com/v21.0/instagram_oembed?url=<post-url>
→ {"error":{"message":"The requested resource does not exist","code":24,
   "error_subcode":2207045,"error_user_title":"Media Not Found",
   "error_user_msg":"...it does not exist or you don't have permission to embed it."}}
```

The endpoint is live but returns nothing usable without a Facebook **App access token**
carrying the `oembed_read` permission. Getting that permission requires a Meta developer
app that has passed **App Review**.

### 4. Anonymous instagram.com — login-walled

```
GET https://www.instagram.com/instagram/  (desktop UA)
→ 302 redirect to login
```

Relevant because it means the WKWebView leg is *also* less certain than TikTok's. TikTok's
embed script hydrates for an anonymous visitor; Instagram redirects anonymous traffic to a
login page. Whether the official embed iframe is exempt from that is **untested** — it
cannot be tested without a token to produce the embed HTML in the first place.

## What this changes

| | TikTok | Instagram |
|---|---|---|
| oEmbed endpoint | public, no auth | requires Meta App token + App Review |
| Anonymous rendering | works | login-walled at the page level; embed untested |
| Transcript from oEmbed | none | none |
| Audio-session blocker | unresolved | unresolved — **same** blocker, not a new one |

The original plan called Instagram "same shape as TikTok, swapping in Instagram's embed
markup." That's true of *our* code — `CaptureBasedExtractor` is genuinely shared, and the
tests prove Instagram reuses the identical pipeline. It is not true of the *access model*.
TikTok needs nothing; Instagram needs a reviewed Meta app.

As instructed, Instagram's audio-session risk is **not** tracked separately. It's the same
unresolved ReplayKit blocker as TikTok's, and fixing it once fixes both.

## What unblocks it

1. Create a Meta developer app; add the **oEmbed Read** product.
2. Submit for App Review with a screencast showing the use case. This is a
   business/legal task with a review turnaround, not an afternoon of coding.
3. Generate an App access token (`{app-id}|{app-secret}`) and provision it as
   `META_OEMBED_TOKEN` (see [SECRETS.md](SECRETS.md)).
4. **Re-run this spike** with a real token, and specifically re-test point 4 above — that
   the returned embed HTML renders and plays for a logged-out viewer inside a WKWebView.
   That is the question this spike could not reach.

Until step 4 passes, `SeerPipelineBuilder` leaves Instagram unregistered and
`supportStatus` reports why.

## Recommendation

Instagram is the lowest-value of the three: it is blocked on someone else's review queue
*and* on the ReplayKit audio problem.

**Updated 2026-07-28.** TikTok no longer shares that second blocker. Its embed iframe
(`tiktok.com/embed/v2/<id>`) turned out to serve a state blob containing a direct CDN URL
for the MP4, so TikTok skips capture entirely — see
[EXTRACTION_PIPELINE.md](EXTRACTION_PIPELINE.md#2-tiktok--working-without-capture).

That changes what to do here. The capture path is now carried *solely* for Instagram, so
"fix ReplayKit" is no longer a fix that pays for itself across two platforms — it is
Instagram-only work, for a platform that is also gated on App Review.

So when a token arrives, add one question to step 4 below, and ask it first:

> Does Instagram's embed iframe expose a media URL the way TikTok's does?

If yes, Instagram takes the `directMediaFetch` arm, both blockers evaporate together, and
the capture path can be deleted rather than debugged. That is a much better outcome than
the one this spike originally recommended, and it costs one HTTP request to find out.
