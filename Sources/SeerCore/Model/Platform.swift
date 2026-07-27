import Foundation

/// A source platform Seer can accept a share from.
public enum Platform: String, Sendable, Equatable, Codable, CaseIterable {
    case youTube
    case tikTok
    case instagram
    /// Anything we can't identify. Routed to no extractor; surfaces as
    /// ``ExtractionError/unsupportedPlatform``.
    case unknown

    /// Which side of the ingestion fork this platform falls on.
    ///
    /// This is the scalability decision, stated once. Adding X or Facebook later means
    /// answering exactly one question — "does it have a native video-ingestion API?" —
    /// and adding a case here, rather than rediscovering the fork per platform.
    public var ingestionStrategy: IngestionStrategy {
        switch self {
        case .youTube:
            // Gemini accepts a YouTube URL directly as a file part. No download, no
            // frame extraction, no capture pipeline.
            return .nativeVideoIngestion
        case .tikTok, .instagram:
            // No public API hands us the media or a transcript, so the only route is to
            // render the embed and record what plays.
            return .screenCapture
        case .unknown:
            return .screenCapture
        }
    }

    /// Best-effort identification from a shared URL.
    public static func detect(from url: URL) -> Platform {
        guard let host = url.host?.lowercased() else { return .unknown }
        // Strip a leading `www.`/`m.` so `m.youtube.com` and `youtube.com` agree.
        let bare = host
            .replacingOccurrences(of: "^(www|m|mobile|vm|vt)\\.", with: "", options: .regularExpression)

        switch bare {
        case "youtube.com", "youtu.be", "youtube-nocookie.com":
            return .youTube
        case "tiktok.com":
            return .tikTok
        case "instagram.com", "instagr.am", "ig.me":
            return .instagram
        default:
            // Handle regional/lang subdomains like `uk.tiktok.com`.
            if bare.hasSuffix(".youtube.com") { return .youTube }
            if bare.hasSuffix(".tiktok.com") { return .tikTok }
            if bare.hasSuffix(".instagram.com") { return .instagram }
            return .unknown
        }
    }
}

/// The fork every platform lands on, made explicit in the type system.
///
/// Both sides produce a ``ClaimContext``; they differ only in cost, latency and
/// failure modes. See ``ClaimExtractor`` for the protocol both conform to.
public enum IngestionStrategy: String, Sendable, Equatable, Codable {
    /// The model ingests the URL itself. Cheap, fast, no on-device media handling.
    /// Available only where a provider has struck a deal with the platform —
    /// today that means Gemini and YouTube.
    case nativeVideoIngestion

    /// Render the platform's embed in a web view, record the screen, transcribe the
    /// audio. Slow, fragile, requires user-facing recording permission — the fallback
    /// for platforms that expose neither media nor transcript.
    case screenCapture
}
