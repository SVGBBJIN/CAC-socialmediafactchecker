import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Resolves a shared TikTok URL to the MP4 behind it.
///
/// ## Why this exists
///
/// TikTok's oEmbed endpoint returns a `blockquote` and a script tag — markup that only
/// becomes a video once the platform's own JavaScript hydrates it in a browser. That is
/// what forced the original screen-capture design, and screen capture is where this
/// pipeline stalled.
///
/// But the thing that script builds is an **iframe pointed at
/// `tiktok.com/embed/v2/<id>`**, and that page is served to anonymous requests. It
/// carries its own state blob — `__FRONTITY_CONNECT_STATE__` — and inside it, under
/// `videoData.itemInfos.video.urls`, is a direct CDN URL for the MP4, alongside the
/// duration, dimensions, caption and author.
///
/// So the whole capture apparatus can be skipped: resolve the embed the iframe would
/// have loaded, read the media URL out of it, fetch the file, hand it to a model that
/// accepts video. No web view, no player, no ReplayKit, no recording permission, and no
/// separate transcription service.
///
/// ## What that costs
///
/// `__FRONTITY_CONNECT_STATE__` is not a documented API. It is the internal
/// server-rendered state of a page TikTok serves to its own iframe, and it can change
/// shape without notice. Two consequences shape the code below:
///
/// - Every parse failure is distinct and loud (see ``ExtractionError/malformedResponse``
///   messages). When TikTok moves this, the error says which step stopped finding what
///   it expected — that is the difference between a ten-minute fix and a re-investigation.
/// - The parse is deliberately permissive about *fields it does not need* and strict
///   about the ones it does, so an added key can't break extraction but a removed
///   `urls` array fails immediately rather than yielding an empty result.
///
/// Verified live on 2026-07-28: the embed page returned HTTP 200 to an anonymous
/// request, the state blob parsed, and the extracted URL served a 3.2 MB `video/mp4`
/// with no credential and no `Referer`. The response is checked in as a fixture in
/// `Tests/SeerCoreTests/TikTokResolverTests.swift`.
public struct TikTokMediaResolver: MediaURLResolver {
    private let transport: any HTTPTransport
    private let policy: RetryPolicy
    private let sleeper: any Sleeper
    private let embedBaseURL: URL

    /// TikTok serves the embed page differently to an obvious bot. This is the same
    /// desktop UA the embed iframe itself would carry.
    static let userAgent =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

    public init(
        transport: any HTTPTransport = URLSessionTransport(),
        policy: RetryPolicy = .metadata,
        sleeper: any Sleeper = TaskSleeper(),
        embedBaseURL: URL = URL(string: "https://www.tiktok.com/embed/v2")!
    ) {
        self.transport = transport
        self.policy = policy
        self.sleeper = sleeper
        self.embedBaseURL = embedBaseURL
    }

    public func resolve(_ url: URL) async throws -> ResolvedMedia {
        let videoID = try await resolveVideoID(from: url)

        var request = URLRequest(url: embedBaseURL.appendingPathComponent(videoID))
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("text/html", forHTTPHeaderField: "Accept")

        let client = RetryingHTTPClient(
            transport: transport, policy: policy, serviceName: "TikTok embed", sleeper: sleeper
        )

        let data: Data
        do {
            data = try await client.send(request)
        } catch let error as ExtractionError {
            // An unknown or deleted ID comes back as a 400 from the embed endpoint, not
            // a 404. Translate it, so the user is told the video isn't there rather than
            // that TikTok rejected our request.
            if case .upstreamFailure(_, let status, _) = error, status == 400 {
                throw ExtractionError.notAMediaURL(url)
            }
            throw error
        }

        return try Self.parse(data, sourceURL: url, videoID: videoID)
    }

    // MARK: - Parsing

    static func parse(_ data: Data, sourceURL: URL, videoID: String) throws -> ResolvedMedia {
        guard let html = String(data: data, encoding: .utf8) else {
            throw ExtractionError.malformedResponse("TikTok embed page was not UTF-8")
        }
        guard let blob = extractStateBlob(from: html) else {
            throw ExtractionError.malformedResponse(
                "TikTok embed page carried no __FRONTITY_CONNECT_STATE__ — the embed page shape has changed"
            )
        }
        guard let state = try? JSONDecoder().decode(EmbedState.self, from: Data(blob.utf8)) else {
            throw ExtractionError.malformedResponse("TikTok embed state was not the expected JSON")
        }

        // The blob keys its payload by the route it rendered.
        guard let page = state.source?.data?["/embed/v2/\(videoID)"] else {
            throw ExtractionError.malformedResponse(
                "TikTok embed state had no entry for /embed/v2/\(videoID)"
            )
        }
        guard let item = page.videoData?.itemInfos else {
            // A valid page that carries no video: private, removed, region-blocked, or
            // a photo-carousel post rather than a video.
            throw ExtractionError.emptyResult(
                reason: "TikTok returned no video for this link — it may be private, removed, or a photo post"
            )
        }
        guard let raw = item.video?.urls?.first(where: { !$0.isEmpty }),
              let mediaURL = URL(string: raw) else {
            throw ExtractionError.emptyResult(
                reason: "TikTok listed no playable source for this video"
            )
        }

        let meta = item.video?.videoMeta
        var extra = ["videoID": videoID]
        if let width = meta?.width, let height = meta?.height {
            extra["dimensions"] = "\(width)x\(height)"
        }
        if let playCount = item.playCount { extra["playCount"] = String(playCount) }

        return ResolvedMedia(
            sourceURL: sourceURL,
            platform: .tikTok,
            mediaURL: mediaURL,
            mimeType: "video/mp4",
            // Not required today — the CDN served the file without one — but the embed
            // player sends it, and matching the player is the cheapest insurance against
            // the CDN tightening up.
            referer: URL(string: "https://www.tiktok.com/"),
            duration: meta?.duration.map(TimeInterval.init),
            authorName: page.videoData?.authorInfos?.nickName ?? page.videoData?.authorInfos?.uniqueId,
            caption: item.text?.isEmpty == false ? item.text : nil,
            thumbnailURL: item.covers?.first.flatMap(URL.init(string:)),
            extra: extra
        )
    }

    /// Pulls the JSON out of `<script id="__FRONTITY_CONNECT_STATE__" …>{…}</script>`.
    ///
    /// Scanned by hand rather than with a regex: the blob is ~24 KB of JSON containing
    /// arbitrary user text, and `NSRegularExpression` over a payload that size — with a
    /// lazy `.*?` spanning it — is both slower and easier to get subtly wrong than
    /// finding two delimiters.
    ///
    /// The name appears more than once on the page: the state blob is followed by
    /// bootstrap code that refers to `window.__FRONTITY_CONNECT_STATE__` by name. So
    /// every occurrence is tried and the first one whose script body actually opens a
    /// JSON object wins, rather than trusting the first match to be the right one.
    static func extractStateBlob(from html: String) -> String? {
        let marker = "__FRONTITY_CONNECT_STATE__"
        var searchStart = html.startIndex

        while let markerRange = html.range(of: marker, range: searchStart..<html.endIndex) {
            searchStart = markerRange.upperBound
            // The opening tag continues past the id attribute; the body starts after `>`.
            guard let tagEnd = html.range(of: ">", range: markerRange.upperBound..<html.endIndex),
                  let closing = html.range(of: "</script>", range: tagEnd.upperBound..<html.endIndex)
            else { continue }

            let body = html[tagEnd.upperBound..<closing.lowerBound]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if body.hasPrefix("{") { return body }
        }
        return nil
    }

    // MARK: - URL → video ID

    /// The numeric ID for a shared URL, following a redirect when the link is a short one.
    func resolveVideoID(from url: URL) async throws -> String {
        if let id = TikTokURL.videoID(from: url) { return id }
        guard TikTokURL.isShortLink(url) else { throw ExtractionError.notAMediaURL(url) }

        // `vm.tiktok.com/ZM…` carries no ID at all — only the redirect knows it. Fetch
        // and read where we landed. URLSession follows redirects, so the response's URL
        // is the canonical one.
        var request = URLRequest(url: url)
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")

        let client = RetryingHTTPClient(
            transport: transport, policy: policy, serviceName: "TikTok short link", sleeper: sleeper
        )
        let (_, response) = try await client.sendReturningResponse(request)

        guard let resolved = response.url, let id = TikTokURL.videoID(from: resolved) else {
            throw ExtractionError.notAMediaURL(url)
        }
        return id
    }
}

/// TikTok URL shapes.
public enum TikTokURL {
    /// The numeric video ID, when the URL states it outright.
    ///
    /// Handles `/@user/video/<id>`, `/embed/v2/<id>`, `/embed/<id>`, `/v/<id>.html` and
    /// a bare `?item_id=`. Returns nil for short links, which have to be followed, and
    /// for `/@user/photo/<id>` carousels, which have no video to fetch.
    public static func videoID(from url: URL) -> String? {
        let segments = Array(url.pathComponents.dropFirst())

        // /@user/photo/<id> — a real post, but a slideshow of stills. Declining here
        // gives the user "that isn't a video" instead of a confusing empty result.
        if segments.contains("photo") { return nil }

        if let index = segments.firstIndex(where: { $0 == "video" || $0 == "v" }),
           index + 1 < segments.count,
           let id = numericID(segments[index + 1]) {
            return id
        }
        // /embed/v2/<id> and /embed/<id>
        if let index = segments.firstIndex(of: "embed") {
            for candidate in segments.dropFirst(index + 1) {
                if let id = numericID(candidate) { return id }
            }
        }
        if let item = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "item_id" })?.value,
           let id = numericID(item) {
            return id
        }
        return nil
    }

    /// Share links that resolve to a real URL only by being followed.
    public static func isShortLink(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        if host == "vm.tiktok.com" || host == "vt.tiktok.com" { return true }
        // The `www.tiktok.com/t/<code>` form is the same redirect with a longer host.
        return url.pathComponents.dropFirst().first == "t"
    }

    /// TikTok IDs are 19-digit snowflakes today, but were shorter in 2019 and there is
    /// no guarantee they stay 19. Checked for shape — all digits, plausible length —
    /// rather than an exact count, which would reject the platform's own oEmbed example.
    static func numericID(_ candidate: String) -> String? {
        let trimmed = candidate.hasSuffix(".html")
            ? String(candidate.dropLast(5))
            : candidate
        guard (8...25).contains(trimmed.count),
              trimmed.allSatisfy(\.isNumber) else { return nil }
        return trimmed
    }
}

// MARK: - Wire shape of the embed page's state blob

// Every field is optional: this is an undocumented internal payload, so the decoder
// tolerates anything missing and the caller decides which absences are fatal.
private struct EmbedState: Decodable {
    var source: Source?

    struct Source: Decodable {
        var data: [String: Page]?
    }

    struct Page: Decodable {
        var videoData: VideoData?
    }

    struct VideoData: Decodable {
        var itemInfos: ItemInfos?
        var authorInfos: AuthorInfos?
    }

    struct ItemInfos: Decodable {
        var id: String?
        var text: String?
        var covers: [String]?
        var video: Video?
        var playCount: Int?
    }

    struct Video: Decodable {
        var urls: [String]?
        var videoMeta: VideoMeta?
    }

    struct VideoMeta: Decodable {
        var width: Int?
        var height: Int?
        var duration: Int?
    }

    struct AuthorInfos: Decodable {
        var nickName: String?
        var uniqueId: String?
    }
}
