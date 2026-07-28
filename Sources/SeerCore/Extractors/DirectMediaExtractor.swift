import Foundation

/// The ``IngestionStrategy/directMediaFetch`` arm: resolve → download → analyse.
///
/// ```
/// shared URL ──▶ MediaURLResolver ──▶ MediaDownloading ──▶ Gemini ──▶ ClaimContext
///                (embed → CDN URL)      (bytes)         (inline or Files)
/// ```
///
/// Structurally this is the same shape as ``CaptureBasedExtractor`` — resolve, obtain
/// media, get text out of it — with the two expensive middle steps replaced. It gets the
/// bytes over HTTP instead of by recording the screen in real time, and it gets the
/// transcript from the video model instead of from a separate speech-to-text service.
///
/// That second substitution is worth more than it first appears. Whisper hears audio and
/// nothing else, so the capture path had to treat on-screen text as unrecoverable. A
/// video model watches, so a clip whose claim is a caption over silent B-roll — a large
/// share of short-form political content — produces `onScreenText` and candidate claims
/// here where the capture path produced an empty transcript.
///
/// Everything is injected, so the pipeline is exercised end to end in tests without a
/// network call.
public struct DirectMediaExtractor: ClaimExtractor {
    public let platform: Platform
    private let resolver: any MediaURLResolver
    private let downloader: any MediaDownloading
    private let client: GeminiVideoClient
    private let filesClient: GeminiFilesClient?
    private let inlineByteLimit: Int

    /// - Parameter filesClient: used when a clip exceeds `inlineByteLimit`. When nil,
    ///   oversized clips fail with a clear error rather than being silently truncated.
    /// - Parameter inlineByteLimit: raw bytes above which the Files API is used instead
    ///   of an inline part. Defaults to 14 MB: `generateContent` caps the whole request
    ///   at 20 MB and base64 costs about a third on top, leaving room for the prompt.
    public init(
        platform: Platform,
        resolver: any MediaURLResolver,
        downloader: any MediaDownloading,
        client: GeminiVideoClient,
        filesClient: GeminiFilesClient? = nil,
        inlineByteLimit: Int = 14 * 1024 * 1024
    ) {
        self.platform = platform
        self.resolver = resolver
        self.downloader = downloader
        self.client = client
        self.filesClient = filesClient
        self.inlineByteLimit = inlineByteLimit
    }

    public func canHandle(_ url: URL) -> Bool {
        Platform.detect(from: url) == platform
    }

    public func extract(from url: URL) async throws -> ClaimContext {
        // 1. Shared URL → direct media URL, plus whatever metadata the embed carried.
        let resolved = try await resolver.resolve(url)

        // 2. Fetch the file. Signed CDN URLs expire, so this follows immediately.
        try Task.checkCancellation()
        let media = try await downloader.download(resolved)

        // 3. Hand it to the model, inline or via Files depending on size.
        try Task.checkCancellation()
        let (result, route) = try await analyse(media, caption: resolved.caption)
        let analysis = result.analysis

        var extra = resolved.extra
        extra["geminiModel"] = result.model.rawValue
        extra["mediaBytes"] = String(media.byteCount)
        extra["uploadRoute"] = route
        if analysis.truncated { extra["truncated"] = "true" }

        return ClaimContext(
            transcript: analysis.transcript,
            // The model watched the video; we never decoded frames ourselves.
            frames: [],
            onScreenText: Self.mergeOnScreenText(analysis.onScreenText, caption: resolved.caption),
            provenance: ProvenanceMetadata(
                platform: platform,
                sourceURL: url,
                strategy: .directMediaFetch,
                authorName: resolved.authorName,
                // Prefer the model's neutral description over the caption, which is
                // marketing copy as often as it is a description.
                title: analysis.title ?? resolved.caption,
                duration: resolved.duration,
                extra: extra
            ),
            candidateClaims: analysis.claims
        )
    }

    private func analyse(
        _ media: DownloadedMedia, caption: String?
    ) async throws -> (GeminiVideoClient.Result, String) {
        guard media.byteCount > inlineByteLimit else {
            let result = try await client.analyzeInlineMedia(
                media.data, mimeType: media.mimeType, context: caption
            )
            return (result, "inline")
        }

        guard let filesClient else {
            throw ExtractionError.emptyResult(
                reason: "clip is \(media.byteCount / 1_048_576) MB, too large to send inline "
                    + "and no Files API client is configured"
            )
        }

        let file = try await filesClient.upload(media.data, mimeType: media.mimeType)
        // Files are billed as storage and expire on their own after 48 hours, but a
        // fact-check run has no reason to leave a stranger's video sitting in the
        // project's file quota once it has been read.
        defer { Task { await filesClient.delete(file) } }

        let result = try await client.analyzeUploadedFile(
            uri: file.uri, mimeType: file.mimeType, context: caption
        )
        return (result, "files")
    }

    /// The caption is on-screen text in every sense that matters downstream — it sits
    /// under the video and it frequently *is* the claim — but it is not what the model
    /// read off the frames, so the two are kept distinguishable rather than concatenated
    /// into an unattributable blob.
    static func mergeOnScreenText(_ detected: String?, caption: String?) -> String? {
        let caption = caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        let detected = detected?.trimmingCharacters(in: .whitespacesAndNewlines)

        switch (detected?.isEmpty == false ? detected : nil, caption?.isEmpty == false ? caption : nil) {
        case (nil, nil): return nil
        case (let detected?, nil): return detected
        case (nil, let caption?): return "Caption: \(caption)"
        case (let detected?, let caption?):
            // A short caption is usually repeated verbatim on screen; don't say it twice.
            if detected.localizedCaseInsensitiveContains(caption) { return detected }
            return "\(detected)\n\nCaption: \(caption)"
        }
    }
}

extension DirectMediaExtractor {
    /// TikTok. Needs no credential beyond the Gemini key — the embed page that yields
    /// the media URL is public. See ``TikTokMediaResolver``.
    public static func tikTok(
        client: GeminiVideoClient,
        filesClient: GeminiFilesClient? = nil,
        resolver: (any MediaURLResolver)? = nil,
        downloader: (any MediaDownloading)? = nil
    ) -> DirectMediaExtractor {
        DirectMediaExtractor(
            platform: .tikTok,
            resolver: resolver ?? TikTokMediaResolver(),
            downloader: downloader ?? MediaDownloader(),
            client: client,
            filesClient: filesClient
        )
    }
}
