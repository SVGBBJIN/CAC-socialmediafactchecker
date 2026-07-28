import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Fetched media bytes.
public struct DownloadedMedia: Sendable, Equatable {
    public var data: Data
    public var mimeType: String

    public init(data: Data, mimeType: String) {
        self.data = data
        self.mimeType = mimeType
    }

    public var byteCount: Int { data.count }
}

/// Fetches the file a ``MediaURLResolver`` pointed at.
public protocol MediaDownloading: Sendable {
    func download(_ media: ResolvedMedia) async throws -> DownloadedMedia
}

/// Downloads media over HTTP, refusing anything past a byte ceiling.
public struct MediaDownloader: MediaDownloading {
    private let transport: any HTTPTransport
    private let policy: RetryPolicy
    private let sleeper: any Sleeper
    private let maxBytes: Int

    /// - Parameter maxBytes: ceiling on what will be handed downstream. Short-form video
    ///   is a few MB; anything far past that is a sign the URL resolved to something
    ///   other than the clip.
    ///
    ///   Note what this does and does not do. ``HTTPTransport`` buffers a whole response
    ///   before returning it, so the check happens *after* the bytes are in memory: it
    ///   stops an absurd file being base64-encoded and uploaded, but it does not stop it
    ///   being downloaded. Capping the transfer itself needs a streaming seam, which the
    ///   transport protocol deliberately doesn't have — every other call in this pipeline
    ///   is a small JSON body. That is an acceptable trade while the only resolver on
    ///   this path yields URLs from TikTok's own metadata for clips it has told us the
    ///   duration of; it would need revisiting before pointing this at arbitrary URLs.
    public init(
        transport: any HTTPTransport = URLSessionTransport.videoUnderstanding(),
        policy: RetryPolicy = RetryPolicy(maxRetries: 2, baseDelay: 1, maxDelay: 8, overallTimeout: 120),
        sleeper: any Sleeper = TaskSleeper(),
        maxBytes: Int = 96 * 1024 * 1024
    ) {
        self.transport = transport
        self.policy = policy
        self.sleeper = sleeper
        self.maxBytes = maxBytes
    }

    public func download(_ media: ResolvedMedia) async throws -> DownloadedMedia {
        var request = URLRequest(url: media.mediaURL)
        request.setValue(TikTokMediaResolver.userAgent, forHTTPHeaderField: "User-Agent")
        if let referer = media.referer {
            request.setValue(referer.absoluteString, forHTTPHeaderField: "Referer")
        }

        let client = RetryingHTTPClient(
            transport: transport, policy: policy, serviceName: "media CDN", sleeper: sleeper
        )
        let (data, response) = try await client.sendReturningResponse(request)

        guard !data.isEmpty else {
            throw ExtractionError.emptyResult(reason: "media URL returned an empty file")
        }
        guard data.count <= maxBytes else {
            throw ExtractionError.emptyResult(
                reason: "media file is \(data.count / 1_048_576) MB, over the \(maxBytes / 1_048_576) MB limit"
            )
        }

        // Trust the server's type over the resolver's guess when it sends a usable one:
        // the resolver infers `video/mp4` from context, the CDN knows.
        let contentType = response.value(forHTTPHeaderField: "Content-Type")?
            .split(separator: ";").first
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let mimeType = (contentType?.contains("/") == true && contentType != "application/octet-stream")
            ? contentType!
            : media.mimeType

        return DownloadedMedia(data: data, mimeType: mimeType)
    }
}

/// A canned downloader, for driving the extractor in tests.
public struct MockMediaDownloader: MediaDownloading {
    private let result: Result<DownloadedMedia, ExtractionError>

    public init(returning media: DownloadedMedia) { self.result = .success(media) }
    public init(failingWith error: ExtractionError) { self.result = .failure(error) }

    /// Bytes that stand in for a real clip.
    public static func bytes(_ count: Int = 2048, mimeType: String = "video/mp4") -> MockMediaDownloader {
        MockMediaDownloader(
            returning: DownloadedMedia(data: Data(repeating: 7, count: count), mimeType: mimeType)
        )
    }

    public func download(_ media: ResolvedMedia) async throws -> DownloadedMedia {
        try result.get()
    }
}
