import Foundation

/// A playable media file we can fetch directly, plus what the platform told us about it.
///
/// This is the output of the ``directMediaFetch`` arm's first step. Unlike
/// ``EmbeddedMedia`` it carries no HTML: nothing renders this, we just fetch it.
public struct ResolvedMedia: Sendable, Equatable {
    /// The URL the user shared.
    public var sourceURL: URL
    public var platform: Platform
    /// Direct URL to the media file itself.
    ///
    /// Generally short-lived and signed — TikTok's carries an expiry in the path — so
    /// this should be fetched promptly rather than stored.
    public var mediaURL: URL
    public var mimeType: String
    /// Some CDNs serve media only to requests that look like they came from the
    /// platform's own page. Sent as `Referer` when fetching ``mediaURL``.
    public var referer: URL?
    public var duration: TimeInterval?
    public var authorName: String?
    /// The post's caption. Not a transcript — it is what the poster typed, which is
    /// frequently a claim in its own right.
    public var caption: String?
    public var thumbnailURL: URL?
    /// Platform-specific odds and ends to pass through to provenance.
    public var extra: [String: String]

    public init(
        sourceURL: URL,
        platform: Platform,
        mediaURL: URL,
        mimeType: String = "video/mp4",
        referer: URL? = nil,
        duration: TimeInterval? = nil,
        authorName: String? = nil,
        caption: String? = nil,
        thumbnailURL: URL? = nil,
        extra: [String: String] = [:]
    ) {
        self.sourceURL = sourceURL
        self.platform = platform
        self.mediaURL = mediaURL
        self.mimeType = mimeType
        self.referer = referer
        self.duration = duration
        self.authorName = authorName
        self.caption = caption
        self.thumbnailURL = thumbnailURL
        self.extra = extra
    }
}

/// Turns a shared URL into a directly fetchable media file.
///
/// The counterpart to ``EmbedResolver`` on the ``IngestionStrategy/directMediaFetch``
/// arm. A new platform on this arm is a conformance here and nothing else.
public protocol MediaURLResolver: Sendable {
    func resolve(_ url: URL) async throws -> ResolvedMedia
}

/// A canned resolver, for driving the extractor in tests without a network call.
public struct MockMediaURLResolver: MediaURLResolver {
    private let result: Result<ResolvedMedia, ExtractionError>

    public init(returning media: ResolvedMedia) { self.result = .success(media) }
    public init(failingWith error: ExtractionError) { self.result = .failure(error) }

    public func resolve(_ url: URL) async throws -> ResolvedMedia { try result.get() }
}
