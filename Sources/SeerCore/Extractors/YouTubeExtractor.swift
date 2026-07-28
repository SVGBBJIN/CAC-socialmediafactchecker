import Foundation

/// YouTube, via Gemini's native URL ingestion.
///
/// No download, no frame extraction, no capture. Gemini fetches the video itself, so
/// the entire "pipeline" is one HTTPS call and a mapping step.
///
/// Two operational caveats worth knowing before this ships:
/// - YouTube URL ingestion is a preview feature. Its pricing and limits can move, and
///   the free tier caps daily YouTube intake (8 hours/day at time of writing).
/// - The video must be public or unlisted. Private, members-only and age-restricted
///   videos fail upstream; that surfaces as an ``ExtractionError/upstreamFailure``.
public struct YouTubeExtractor: ClaimExtractor {
    public let platform: Platform = .youTube
    private let client: GeminiVideoClient
    private let maxDuration: TimeInterval?

    /// - Parameter maxDuration: when set, only the first `maxDuration` seconds are
    ///   analysed. A cost guard: a shared three-hour stream would otherwise be billed
    ///   in full, and the claim a user wants checked is almost always near the start of
    ///   what they shared.
    public init(client: GeminiVideoClient, maxDuration: TimeInterval? = nil) {
        self.client = client
        self.maxDuration = maxDuration
    }

    public func canHandle(_ url: URL) -> Bool {
        guard Platform.detect(from: url) == .youTube else { return false }
        return YouTubeExtractor.videoID(from: url) != nil
    }

    public func extract(from url: URL, progress: ProgressSink) async throws -> ClaimContext {
        progress.send(.resolving)
        guard let videoID = YouTubeExtractor.videoID(from: url) else {
            throw ExtractionError.notAMediaURL(url)
        }
        // Normalise before sending: share links carry playlist, timestamp and referrer
        // parameters, and a canonical watch URL is what the API expects.
        let canonical = YouTubeExtractor.canonicalURL(for: videoID)
        let clip = maxDuration.map { GeminiClip(start: 0, end: $0) }

        // Everything from here is one HTTPS call that returns only when Gemini has
        // finished watching. There is no interim signal to forward, which is exactly
        // why the stage needs announcing before it starts.
        progress.send(.analysing)
        let result = try await client.analyzeVideo(at: canonical, clip: clip)
        let analysis = result.analysis

        var extra = [
            "videoID": videoID,
            "geminiModel": result.model.rawValue,
        ]
        if analysis.truncated {
            extra["truncated"] = "true"
        }
        if let maxDuration {
            extra["analysedSeconds"] = String(Int(maxDuration))
        }

        return ClaimContext(
            transcript: analysis.transcript,
            frames: [],  // The model watched the video; we never held the pixels.
            onScreenText: analysis.onScreenText,
            provenance: ProvenanceMetadata(
                platform: .youTube,
                sourceURL: url,
                strategy: .nativeVideoIngestion,
                title: analysis.title,
                extra: extra
            ),
            candidateClaims: analysis.claims
        )
    }

    // MARK: - URL handling

    /// Extracts the 11-character video ID from any of YouTube's share formats.
    ///
    /// Handled: `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`, `/v/`.
    /// Deliberately rejected: channel, playlist-only and user URLs — there is no single
    /// video to ingest, and `canHandle` returning false lets the pipeline give the user
    /// a clear "that isn't a video" instead of a confusing upstream error.
    public static func videoID(from url: URL) -> String? {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let host = url.host?.lowercased() ?? ""

        let pathSegments: [String] = Array(url.pathComponents.dropFirst())

        // Matched as a domain, not a substring. `canHandle` gates on `Platform.detect`
        // first, but this is `public static` and documented for standalone use, so it
        // can't lean on that: `contains` would treat `youtu.be.example.com` as a short
        // link and read a video ID off an unrelated host's path.
        if host == "youtu.be" || host.hasSuffix(".youtu.be") {
            guard let candidate = pathSegments.first, isValidVideoID(candidate) else { return nil }
            return candidate
        }

        if let queryID = components?.queryItems?.first(where: { $0.name == "v" })?.value,
           isValidVideoID(queryID) {
            return queryID
        }

        let videoPathPrefixes: Set<String> = ["shorts", "embed", "live", "v"]
        if let first = pathSegments.first, videoPathPrefixes.contains(first.lowercased()),
           pathSegments.count > 1, isValidVideoID(pathSegments[1]) {
            return pathSegments[1]
        }

        return nil
    }

    /// YouTube IDs are exactly 11 characters of base64url. Checking the shape stops a
    /// `/shorts/` path segment that is really a slug from being sent upstream.
    static func isValidVideoID(_ candidate: String) -> Bool {
        guard candidate.count == 11 else { return false }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        return candidate.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    static func canonicalURL(for videoID: String) -> URL {
        URL(string: "https://www.youtube.com/watch?v=\(videoID)")!
    }
}
