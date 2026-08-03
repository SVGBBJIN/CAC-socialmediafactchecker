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
            // Screen capture (WKWebView + RPScreenRecorder + Whisper) is the primary
            // path: see TikTokCaptureFirstExtractor. TikTok's embed page also hands out
            // a direct CDN URL for the MP4, and that direct-fetch path is wired in as
            // the automatic fallback when capture fails — most notably the known
            // ReplayKit/WKWebView silent-audio defect. A configuration with no capture
            // source falls back to direct-fetch alone; see SeerPipelineBuilder.
            return .screenCapture
        case .instagram:
            // Login-walled: no route to the media without a Meta token, so the embed
            // still has to be rendered and recorded. See docs/SPIKE-instagram.md.
            return .screenCapture
        case .unknown:
            return .screenCapture
        }
    }

    /// Hosts this platform's media bytes may be fetched from, matched as domain suffixes.
    ///
    /// The media URL on the ``IngestionStrategy/directMediaFetch`` arm is read out of a
    /// third party's undocumented JSON blob, which makes it the one attacker-influenced
    /// URL in the pipeline: the page it comes from is fixed, but its *contents* are not.
    /// Without this list, `MediaDownloader` fetches whatever that blob names, on a path
    /// anyone can reach by sharing a link.
    ///
    /// **Empty means fetch nothing.** A platform that has not declared its CDN families
    /// cannot be downloaded from at all, which is the safe direction for the failure: a
    /// missing entry is a one-line fix with an error message that names the host it
    /// rejected, where a permissive default is a hole nobody sees. That is why this is on
    /// `Platform` and not a parameter with a default — there is no "unrestricted" value
    /// to accidentally leave in place.
    public var allowedMediaHosts: [String] {
        switch self {
        case .tikTok:
            return [
                "tiktokcdn.com",
                "tiktokcdn-us.com",
                "tiktokcdn-eu.com",
                "tiktokcdn-in.com",
                "tiktokv.com",
                "tiktokv.us",
                "ttwstatic.com",
                "muscdn.com",
                "byteoversea.com",
            ]
        case .youTube:
            // Native ingestion: Gemini fetches the video, we never hold the bytes.
            return []
        case .instagram:
            // Still on the capture arm in Swift. The web app's resolver names
            // `cdninstagram.com` and `fbcdn.net`; this gets filled in with the port,
            // not before it, so an unported platform can't download by accident.
            return []
        case .unknown:
            return []
        }
    }

    /// Whether `host` is one of ``allowedMediaHosts``.
    ///
    /// Suffix-matched against a dot boundary, never a substring, so
    /// `tiktokcdn.com.evil.test` does not pass for `tiktokcdn.com`.
    public func allowsMediaHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased(), !host.isEmpty else { return false }
        return allowedMediaHosts.contains { host == $0 || host.hasSuffix(".\($0)") }
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
