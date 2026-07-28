import Foundation

/// An extractor that performs a run instead of doing one.
///
/// It walks a list of stages on a timer and returns a canned ``ClaimContext``. No
/// network, no credential, no Gemini key — which is what makes it useful in three places
/// that otherwise cannot see the pipeline work at all:
///
/// - **`SeerUIDemo`**, so the progress animation can be run and looked at. Judging an
///   animation requires watching it, and every real extractor needs a key and a live
///   video to produce one.
/// - **SwiftUI previews**, which cannot make network calls.
/// - **Tests of the staging contract itself**, where the interesting thing is the
///   sequence of events rather than what produced them.
///
/// The scripts come from ``ExtractionStage/expected(for:)``, so a demo shows the stage
/// list a real run of that platform would produce rather than a hand-written guess that
/// drifts from it.
public struct ScriptedExtractor: ClaimExtractor {
    /// One stage, and how long to appear to spend in it.
    public struct Beat: Sendable, Equatable {
        public var stage: ExtractionStage
        public var detail: String?
        /// Seconds to wait *after* announcing the stage.
        public var duration: TimeInterval

        public init(_ stage: ExtractionStage, detail: String? = nil, duration: TimeInterval = 0) {
            self.stage = stage
            self.detail = detail
            self.duration = duration
        }
    }

    public let platform: Platform
    public let beats: [Beat]

    private let outcome: Result<ClaimContext, ExtractionError>?
    private let sleeper: any Sleeper
    private let accepts: @Sendable (URL) -> Bool

    /// - Parameter beats: the stages to walk, in order. ``ExtractionStage/done`` is not
    ///   one of them — the pipeline emits that itself once it has accepted a result, and
    ///   including it here would produce two.
    /// - Parameter outcome: what to return once the script runs out. Defaults to a
    ///   plausible context built from the URL, so the common case needs no argument.
    ///   Pass a `.failure` to demonstrate the error path.
    /// - Parameter accepts: which URLs this extractor claims. Defaults to matching
    ///   `platform`, so several scripted extractors can sit in one pipeline and route by
    ///   link exactly as the real ones do.
    public init(
        platform: Platform,
        beats: [Beat],
        outcome: Result<ClaimContext, ExtractionError>? = nil,
        sleeper: any Sleeper = TaskSleeper(),
        accepts: (@Sendable (URL) -> Bool)? = nil
    ) {
        self.platform = platform
        self.beats = beats.filter { $0.stage != .done }
        self.outcome = outcome
        self.sleeper = sleeper
        self.accepts = accepts ?? { url in Platform.detect(from: url) == platform }
    }

    public func canHandle(_ url: URL) -> Bool { accepts(url) }

    public func extract(from url: URL, progress: ProgressSink) async throws -> ClaimContext {
        for beat in beats {
            try Task.checkCancellation()
            progress.send(beat.stage, detail: beat.detail)
            try await sleeper.sleep(for: beat.duration)
        }
        try Task.checkCancellation()

        switch outcome {
        case .success(let context): return context
        case .failure(let error): throw error
        case nil: return Self.sampleContext(platform: platform, sourceURL: url)
        }
    }

    // MARK: - Scripts

    /// The stages a real run of `platform` would report, paced for watching.
    ///
    /// `pace` scales every wait, so a preview can run the same script instantly
    /// (`pace: 0`) that the demo runs at human speed.
    ///
    /// - Parameter includeUpload: adds the ``ExtractionStage/uploading`` beat, which a
    ///   real run only reaches for a clip too large to send inline. Worth being able to
    ///   show on demand: it is the one stage that appears mid-run rather than being laid
    ///   out up front, so it is the one that exercises the stage list's insertion path.
    public static func script(
        for platform: Platform,
        pace: TimeInterval = 1,
        includeUpload: Bool = false
    ) -> [Beat] {
        var beats: [Beat] = []
        for stage in ExtractionStage.expected(for: platform) where stage != .done {
            if stage == .analysing, includeUpload {
                beats.append(Beat(.uploading, detail: "18.4 MB", duration: 3 * pace))
            }
            beats.append(
                Beat(stage, detail: detail(for: stage), duration: duration(for: stage) * pace)
            )
        }
        return beats
    }

    /// Deliberately longer than ``ExtractionProgress/patienceThreshold`` for `analysing`,
    /// so a demo run actually reaches the point where the interface has to explain
    /// itself. That threshold is the whole reason the explanation text exists, and an
    /// animation that never crosses it can't be judged.
    private static func duration(for stage: ExtractionStage) -> TimeInterval {
        switch stage {
        case .resolving: return 1.5
        case .fetchingMedia: return 2.5
        case .uploading: return 3
        case .analysing: return 16
        case .done: return 0
        }
    }

    private static func detail(for stage: ExtractionStage) -> String? {
        switch stage {
        case .fetchingMedia: return "10s clip"
        case .analysing: return "3.1 MB"
        default: return nil
        }
    }

    /// A context with enough in it to look like a real result.
    public static func sampleContext(platform: Platform, sourceURL: URL) -> ClaimContext {
        ClaimContext(
            transcript: """
                They keep saying the number went down last year. It did not go down. \
                It went up by eleven percent, and nobody wants to talk about it.
                """,
            onScreenText: "Caption: the chart they don't want you to see",
            provenance: ProvenanceMetadata(
                platform: platform,
                sourceURL: sourceURL,
                strategy: platform.ingestionStrategy,
                authorName: "@example",
                title: "A claim about last year's figures",
                duration: 10,
                extra: ["scripted": "true"]
            ),
            candidateClaims: [
                CandidateClaim(
                    text: "The figure rose by eleven percent last year.",
                    timestamp: 4,
                    sourceQuote: "It went up by eleven percent"
                )
            ]
        )
    }
}
