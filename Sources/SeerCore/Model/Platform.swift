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
        case .tikTok:
            // TikTok's embed page hands out a direct CDN URL for the MP4, so we can
            // fetch the media ourselves and give the bytes to the model. No player, no
            // recording, no screen-capture permission.
            return .directMediaFetch
        case .instagram:
            // Login-walled: no route to the media without a Meta token, so the embed
            // still has to be rendered and recorded. See docs/SPIKE-instagram.md.
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
/// Every arm produces a ``ClaimContext``; they differ only in cost, latency and
/// failure modes. See ``ClaimExtractor`` for the protocol they all conform to.
///
/// The question to ask when adding a platform, in order — each arm is strictly
/// cheaper and less fragile than the one below it:
///
/// 1. Will the model fetch the URL itself? → ``nativeVideoIngestion``
/// 2. Can *we* get at the media file? → ``directMediaFetch``
/// 3. Neither → ``screenCapture``
public enum IngestionStrategy: String, Sendable, Equatable, Codable {
    /// The model ingests the URL itself. Cheap, fast, no on-device media handling.
    /// Available only where a provider has struck a deal with the platform —
    /// today that means Gemini and YouTube.
    case nativeVideoIngestion

    /// We resolve the platform's own embed to a direct media URL, fetch the bytes, and
    /// hand them to the model. More work than ``nativeVideoIngestion`` — the media does
    /// travel through the device — but it needs no player, no recording permission and
    /// no separate transcription service, and it runs at network speed rather than in
    /// real time.
    ///
    /// The tradeoff is that it leans on an undocumented shape in a page the platform
    /// serves to its own embed iframe. That can change without notice, so a resolver on
    /// this arm has to fail loudly when the shape moves rather than quietly return
    /// nothing.
    case directMediaFetch

    /// Render the platform's embed in a web view, record the screen, transcribe the
    /// audio. Slow, fragile, requires user-facing recording permission — the last
    /// resort for platforms that expose neither media nor transcript.
    case screenCapture
}
