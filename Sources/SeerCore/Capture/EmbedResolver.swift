import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What a platform's oEmbed endpoint gave us: metadata plus HTML to render.
public struct EmbeddedMedia: Sendable, Equatable {
    public var sourceURL: URL
    public var platform: Platform
    /// HTML to load in a web view. Platform embed markup expects to run its own
    /// script, so this is loaded as a full document rather than injected.
    public var html: String
    public var authorName: String?
    public var title: String?
    public var thumbnailURL: URL?
    /// Best-guess duration, when the platform reports one. oEmbed usually does not,
    /// which is why ``CaptureBasedExtractor`` takes a capture duration explicitly.
    public var duration: TimeInterval?

    public init(
        sourceURL: URL,
        platform: Platform,
        html: String,
        authorName: String? = nil,
        title: String? = nil,
        thumbnailURL: URL? = nil,
        duration: TimeInterval? = nil
    ) {
        self.sourceURL = sourceURL
        self.platform = platform
        self.html = html
        self.authorName = authorName
        self.title = title
        self.thumbnailURL = thumbnailURL
        self.duration = duration
    }
}

/// Turns a shared URL into something renderable.
public protocol EmbedResolver: Sendable {
    func resolve(_ url: URL) async throws -> EmbeddedMedia
}

/// Standard oEmbed client.
///
/// oEmbed gives us metadata and embed HTML — never the media, and never a transcript.
/// That absence is the whole reason the capture path exists.
public struct OEmbedResolver: EmbedResolver {
    private let endpoint: URL
    private let platform: Platform
    private let transport: any HTTPTransport
    private let policy: RetryPolicy
    private let sleeper: any Sleeper
    /// Extra query items, e.g. Meta's required `access_token`.
    private let additionalQueryItems: [URLQueryItem]

    public init(
        endpoint: URL,
        platform: Platform,
        transport: any HTTPTransport = URLSessionTransport(),
        policy: RetryPolicy = .metadata,
        sleeper: any Sleeper = TaskSleeper(),
        additionalQueryItems: [URLQueryItem] = []
    ) {
        self.endpoint = endpoint
        self.platform = platform
        self.transport = transport
        self.policy = policy
        self.sleeper = sleeper
        self.additionalQueryItems = additionalQueryItems
    }

    /// TikTok's endpoint is public and needs no credential — verified 2026-07-27.
    public static func tikTok(
        transport: any HTTPTransport = URLSessionTransport(),
        sleeper: any Sleeper = TaskSleeper()
    ) -> OEmbedResolver {
        OEmbedResolver(
            endpoint: URL(string: "https://www.tiktok.com/oembed")!,
            platform: .tikTok,
            transport: transport,
            sleeper: sleeper
        )
    }

    /// Instagram's endpoint, which requires a Facebook App access token with
    /// `oembed_read`. The legacy token-free `api.instagram.com/oembed` was retired and
    /// now returns HTTP 500 — see docs/SPIKE-instagram.md.
    public static func instagram(
        accessToken: String,
        transport: any HTTPTransport = URLSessionTransport(),
        sleeper: any Sleeper = TaskSleeper()
    ) -> OEmbedResolver {
        OEmbedResolver(
            endpoint: URL(string: "https://graph.facebook.com/v21.0/instagram_oembed")!,
            platform: .instagram,
            transport: transport,
            sleeper: sleeper,
            additionalQueryItems: [URLQueryItem(name: "access_token", value: accessToken)]
        )
    }

    public func resolve(_ url: URL) async throws -> EmbeddedMedia {
        let canonical = await expandedShortLink(url)

        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        components.queryItems =
            [URLQueryItem(name: "url", value: canonical.absoluteString)] + additionalQueryItems

        guard let requestURL = components.url else {
            throw ExtractionError.notAMediaURL(url)
        }

        var request = URLRequest(url: requestURL)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let client = RetryingHTTPClient(
            transport: transport,
            policy: policy,
            serviceName: "\(platform.rawValue) oEmbed",
            sleeper: sleeper
        )
        let data = try await client.send(request)
        // Provenance keeps the URL the user actually shared, not the expanded one.
        return try Self.parse(data, sourceURL: url, platform: platform)
    }

    /// Expands a share-sheet short link into the canonical post URL.
    ///
    /// TikTok's own "Copy link" produces `vm.tiktok.com/…`, `vt.tiktok.com/…` or
    /// `tiktok.com/t/…` — redirect keys, not post URLs — so this is the *typical* input,
    /// not an edge case. The oEmbed endpoint does not follow them; handed one it simply
    /// fails. `URLSession` does follow redirects, so a HEAD request lands on the real URL
    /// and reports it back via `response.url`.
    ///
    /// Best-effort by design: if expansion fails, the original URL goes to oEmbed so the
    /// error the user sees comes from the endpoint rather than from this hop.
    private func expandedShortLink(_ url: URL) async -> URL {
        guard Self.isShortLink(url) else { return url }

        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        guard let (_, response) = try? await transport.send(request),
              let resolved = response.url,
              !Self.isShortLink(resolved)
        else { return url }
        return resolved
    }

    static func isShortLink(_ url: URL) -> Bool {
        let host = url.host?.lowercased() ?? ""
        if host.hasPrefix("vm.") || host.hasPrefix("vt.") { return true }
        let segments = url.pathComponents.dropFirst()
        return host.hasSuffix("tiktok.com") && segments.first?.lowercased() == "t"
    }

    static func parse(_ data: Data, sourceURL: URL, platform: Platform) throws -> EmbeddedMedia {
        struct Payload: Decodable {
            var html: String?
            var title: String?
            var authorName: String?
            var thumbnailURL: String?

            enum CodingKeys: String, CodingKey {
                case html, title
                case authorName = "author_name"
                case thumbnailURL = "thumbnail_url"
            }
        }

        guard let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            throw ExtractionError.malformedResponse("oEmbed response was not JSON")
        }
        guard let html = payload.html, !html.isEmpty else {
            throw ExtractionError.malformedResponse("oEmbed response carried no embed HTML")
        }

        return EmbeddedMedia(
            sourceURL: sourceURL,
            platform: platform,
            html: html,
            authorName: payload.authorName,
            title: payload.title,
            thumbnailURL: payload.thumbnailURL.flatMap(URL.init(string:))
        )
    }
}

extension EmbeddedMedia {
    /// Wraps the embed fragment in a document a web view can load.
    ///
    /// The platform blockquote alone will not play: it needs the platform's own script
    /// to hydrate it into a player, and a viewport that doesn't letterbox a vertical
    /// video into a corner.
    public func standaloneDocument() -> String {
        """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
        <style>
          html, body { margin: 0; padding: 0; background: #000; height: 100%; overflow: hidden; }
          body { display: flex; align-items: center; justify-content: center; }
          blockquote, iframe { max-width: 100% !important; min-width: 0 !important; }
        </style>
        </head>
        <body>
        \(html)
        </body>
        </html>
        """
    }
}
