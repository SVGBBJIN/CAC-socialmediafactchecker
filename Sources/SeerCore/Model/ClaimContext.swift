import Foundation

/// The single output shape of the extraction layer.
///
/// Everything downstream — claim detection, retrieval, verdict rendering — consumes
/// `ClaimContext` and nothing else. It carries no hint of *how* the content was
/// obtained: a YouTube link resolved through Gemini's native video ingestion and a
/// TikTok clip screen-recorded and pushed through Whisper both land here identically.
///
/// That is the contract. If a field would only ever be populated by one platform,
/// it belongs in ``ClaimContext/ProvenanceMetadata/extra``, not on this type.
public struct ClaimContext: Sendable, Equatable, Codable {
    /// Spoken-word transcript of the media. The one field every path must produce.
    ///
    /// May be empty when a piece of media genuinely has no speech (a silent clip with
    /// on-screen text). Empty is a legitimate result; *failure* to transcribe is an
    /// error, not an empty transcript. Downstream can distinguish the two by checking
    /// `frames` and `onScreenText`.
    public var transcript: String

    /// Optional sampled frames, for claims that live in the visuals rather than the
    /// audio — a doctored chart, a fabricated headline screenshot.
    public var frames: [ClaimFrame]

    /// Text burned into the video or supplied as a caption, when the extractor can
    /// recover it. Kept separate from `transcript` because on-screen text and speech
    /// carry different evidentiary weight.
    public var onScreenText: String?

    /// Where this came from and how it was obtained.
    public var provenance: ProvenanceMetadata

    /// Claims the extractor already spotted, when the underlying model surfaced them
    /// for free (the Gemini path does; the transcription path generally does not).
    ///
    /// These are *hints*, not results. The fact-check layer owns claim detection and
    /// is free to ignore this entirely. It exists so the video-native path doesn't
    /// throw away work it has already paid for.
    public var candidateClaims: [CandidateClaim]

    public init(
        transcript: String,
        frames: [ClaimFrame] = [],
        onScreenText: String? = nil,
        provenance: ProvenanceMetadata,
        candidateClaims: [CandidateClaim] = []
    ) {
        self.transcript = transcript
        self.frames = frames
        self.onScreenText = onScreenText
        self.provenance = provenance
        self.candidateClaims = candidateClaims
    }
}

extension ClaimContext {
    /// True when there is nothing for the fact-check layer to work with.
    public var isEmpty: Bool {
        transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (onScreenText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            && frames.isEmpty
    }
}

/// A single sampled video frame.
public struct ClaimFrame: Sendable, Equatable, Codable {
    /// Offset from the start of the media.
    public var timestamp: TimeInterval
    /// Encoded still image (JPEG/PNG). Held as `Data` so the core stays free of UIKit.
    public var imageData: Data
    /// MIME type of `imageData`, e.g. `image/jpeg`.
    public var mimeType: String
    /// Optional model-supplied description of what the frame shows.
    public var caption: String?

    public init(timestamp: TimeInterval, imageData: Data, mimeType: String = "image/jpeg", caption: String? = nil) {
        self.timestamp = timestamp
        self.imageData = imageData
        self.mimeType = mimeType
        self.caption = caption
    }
}

/// A claim the extractor noticed in passing.
public struct CandidateClaim: Sendable, Equatable, Codable {
    /// The claim, stated plainly.
    public var text: String
    /// Where in the media it was made, when known.
    public var timestamp: TimeInterval?
    /// Verbatim supporting span from the transcript, when the model supplied one.
    public var sourceQuote: String?

    public init(text: String, timestamp: TimeInterval? = nil, sourceQuote: String? = nil) {
        self.text = text
        self.timestamp = timestamp
        self.sourceQuote = sourceQuote
    }
}

/// Where a `ClaimContext` came from.
public struct ProvenanceMetadata: Sendable, Equatable, Codable {
    public var platform: Platform
    /// The URL the user shared.
    public var sourceURL: URL
    /// Which side of the ingestion fork produced this. Diagnostics and cost
    /// accounting only — no downstream logic should branch on it.
    public var strategy: IngestionStrategy
    public var authorName: String?
    public var title: String?
    public var duration: TimeInterval?
    public var extractedAt: Date
    /// Platform-specific odds and ends that don't deserve a first-class field.
    public var extra: [String: String]

    public init(
        platform: Platform,
        sourceURL: URL,
        strategy: IngestionStrategy,
        authorName: String? = nil,
        title: String? = nil,
        duration: TimeInterval? = nil,
        extractedAt: Date = Date(),
        extra: [String: String] = [:]
    ) {
        self.platform = platform
        self.sourceURL = sourceURL
        self.strategy = strategy
        self.authorName = authorName
        self.title = title
        self.duration = duration
        self.extractedAt = extractedAt
        self.extra = extra
    }
}
