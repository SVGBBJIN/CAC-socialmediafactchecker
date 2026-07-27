import Foundation

/// Produces recorded media for a piece of embedded content.
///
/// **This protocol is the point of the capture path.** `RPScreenRecorder` has an
/// unresolved defect for our use case (see ``MockCaptureSource`` and
/// docs/EXTRACTION_PIPELINE.md): it frequently yields *silent* audio when the sound is
/// coming from a `WKWebView`, because the web view's audio session is separate from the
/// one ReplayKit taps. Until that is resolved, no amount of downstream work can be
/// validated against the real recorder.
///
/// So the recorder is behind this seam. Everything after capture — transcription,
/// claim extraction, the mapping into ``ClaimContext`` — is developed and tested
/// against ``MockCaptureSource`` and is finished, tested code today. When the audio
/// problem is solved, the real implementation drops in behind the same protocol and
/// nothing downstream changes.
///
/// It is also what lets Instagram reuse TikTok's pipeline: the two platforms differ in
/// their embed markup, not in how the recording is taken.
public protocol MediaCaptureSource: Sendable {
    /// Render `embed` and record it.
    ///
    /// - Parameter embed: what to render, resolved by an ``EmbedResolver``.
    /// - Parameter duration: how long to record for.
    /// - Returns: the recording, plus what was actually captured.
    func capture(embed: EmbeddedMedia, duration: TimeInterval) async throws -> CapturedMedia
}

/// The output of a capture.
public struct CapturedMedia: Sendable, Equatable {
    /// Encoded media — audio-only or audio+video depending on the source.
    public var data: Data
    /// MIME type of `data`, e.g. `audio/m4a`, `video/quicktime`.
    public var mimeType: String
    public var duration: TimeInterval
    /// Frames sampled during capture, when the source produced any.
    public var frames: [ClaimFrame]
    /// Whether the source believes it captured usable audio.
    ///
    /// Explicit rather than inferred because the failure this pipeline is most likely
    /// to hit — ReplayKit handing back a well-formed file full of silence — looks
    /// exactly like a successful capture at every other layer. A source that can tell
    /// says so here, and ``CaptureBasedExtractor`` refuses to spend a transcription
    /// call on it.
    public var containsAudio: Bool

    public init(
        data: Data,
        mimeType: String,
        duration: TimeInterval,
        frames: [ClaimFrame] = [],
        containsAudio: Bool = true
    ) {
        self.data = data
        self.mimeType = mimeType
        self.duration = duration
        self.frames = frames
        self.containsAudio = containsAudio
    }
}

/// A canned capture source.
///
/// Used to build and test everything downstream of capture while the ReplayKit audio
/// problem is open, and to reproduce that problem's signature in tests via
/// ``MockCaptureSource/silent(duration:)``.
public struct MockCaptureSource: MediaCaptureSource {
    private let result: Result<CapturedMedia, ExtractionError>
    private let artificialDelay: TimeInterval

    public init(returning media: CapturedMedia, delay: TimeInterval = 0) {
        self.result = .success(media)
        self.artificialDelay = delay
    }

    public init(failingWith error: ExtractionError) {
        self.result = .failure(error)
        self.artificialDelay = 0
    }

    /// A capture that succeeds structurally but has no audio in it — the exact shape of
    /// the `RPScreenRecorder` + `WKWebView` failure.
    public static func silent(duration: TimeInterval = 15) -> MockCaptureSource {
        MockCaptureSource(
            returning: CapturedMedia(
                data: Data(repeating: 0, count: 1024),
                mimeType: "audio/m4a",
                duration: duration,
                containsAudio: false
            )
        )
    }

    /// A capture that carries audio, for exercising the happy path.
    public static func speaking(
        _ payload: Data = Data("mock-audio".utf8),
        duration: TimeInterval = 15
    ) -> MockCaptureSource {
        MockCaptureSource(
            returning: CapturedMedia(
                data: payload, mimeType: "audio/m4a", duration: duration, containsAudio: true
            )
        )
    }

    public func capture(embed: EmbeddedMedia, duration: TimeInterval) async throws -> CapturedMedia {
        if artificialDelay > 0 {
            try await Task.sleep(nanoseconds: UInt64(artificialDelay * 1_000_000_000))
        }
        return try result.get()
    }
}
