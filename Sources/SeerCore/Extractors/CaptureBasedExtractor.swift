import Foundation

/// The screen-capture side of the ingestion fork: oEmbed → render → record → transcribe.
///
/// Written once and shared by TikTok and Instagram, because they differ only in which
/// ``EmbedResolver`` they use. That is the whole reuse story — a new capture-path
/// platform is a resolver and a `Platform` case, not another pipeline.
///
/// The capture step is injected (``MediaCaptureSource``), so this type and everything
/// downstream of it are testable and complete while the ReplayKit audio defect is
/// still open.
public struct CaptureBasedExtractor: ClaimExtractor {
    public let platform: Platform
    private let resolver: any EmbedResolver
    private let captureSource: any MediaCaptureSource
    private let transcriber: any Transcriber
    private let captureDuration: TimeInterval

    /// - Parameter captureDuration: how long to record. oEmbed doesn't report duration,
    ///   so this is a fixed window rather than a measured one. 60s covers the
    ///   overwhelming majority of short-form clips.
    public init(
        platform: Platform,
        resolver: any EmbedResolver,
        captureSource: any MediaCaptureSource,
        transcriber: any Transcriber,
        captureDuration: TimeInterval = 60
    ) {
        self.platform = platform
        self.resolver = resolver
        self.captureSource = captureSource
        self.transcriber = transcriber
        self.captureDuration = captureDuration
    }

    public func canHandle(_ url: URL) -> Bool {
        Platform.detect(from: url) == platform
    }

    public func extract(from url: URL, progress: ProgressSink) async throws -> ClaimContext {
        // 1. Metadata + embed HTML. No media and no transcript here — oEmbed offers
        //    neither, on any platform.
        progress.send(.resolving)
        let embed = try await resolver.resolve(url)

        // 2. Render and record. Unlike every other stage this one runs in real time —
        //    a 60s clip takes 60s — so announcing it with the duration matters more
        //    here than elsewhere.
        try Task.checkCancellation()
        let duration = embed.duration ?? captureDuration
        progress.send(.fetchingMedia, detail: "recording \(Int(duration))s")
        let captured = try await captureSource.capture(
            embed: embed,
            duration: duration
        )

        // 3. Fail loudly on a silent recording rather than passing it on.
        //    This is the known ReplayKit/WKWebView failure, and it has to be caught
        //    here: a silent capture transcribes to "" and an empty transcript is
        //    indistinguishable downstream from a video that genuinely says nothing.
        guard captured.containsAudio else {
            throw ExtractionError.emptyResult(
                reason: "screen recording captured no audio — see the WKWebView audio-session issue"
            )
        }

        // 4. Transcribe.
        try Task.checkCancellation()
        progress.send(.analysing)
        let transcription = try await transcriber.transcribe(captured)

        return ClaimContext(
            transcript: transcription.text,
            frames: captured.frames,
            onScreenText: embed.title,
            provenance: ProvenanceMetadata(
                platform: platform,
                sourceURL: url,
                strategy: .screenCapture,
                authorName: embed.authorName,
                title: embed.title,
                duration: captured.duration,
                extra: [
                    "transcriptionModel": transcription.model ?? "unknown",
                    "language": transcription.language ?? "unknown",
                    "capturedSeconds": String(Int(captured.duration)),
                ]
            ),
            // The transcription path surfaces no claims; the fact-check layer does its
            // own detection. Empty here is expected, not a failure.
            candidateClaims: []
        )
    }
}

extension CaptureBasedExtractor {
    /// TikTok. The oEmbed endpoint is public and needs no credential.
    public static func tikTok(
        captureSource: any MediaCaptureSource,
        transcriber: any Transcriber,
        resolver: (any EmbedResolver)? = nil,
        captureDuration: TimeInterval = 60
    ) -> CaptureBasedExtractor {
        CaptureBasedExtractor(
            platform: .tikTok,
            resolver: resolver ?? OEmbedResolver.tikTok(),
            captureSource: captureSource,
            transcriber: transcriber,
            captureDuration: captureDuration
        )
    }

    /// Instagram. Requires a Meta app access token — see docs/SPIKE-instagram.md for
    /// why this can't be stood up without Meta app review, and what the spike found.
    public static func instagram(
        accessToken: String,
        captureSource: any MediaCaptureSource,
        transcriber: any Transcriber,
        resolver: (any EmbedResolver)? = nil,
        captureDuration: TimeInterval = 60
    ) -> CaptureBasedExtractor {
        CaptureBasedExtractor(
            platform: .instagram,
            resolver: resolver ?? OEmbedResolver.instagram(accessToken: accessToken),
            captureSource: captureSource,
            transcriber: transcriber,
            captureDuration: captureDuration
        )
    }
}
