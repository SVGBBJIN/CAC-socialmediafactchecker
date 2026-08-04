import Foundation

/// Where an extraction has got to.
///
/// Extraction is slow in a way users read as broken: the YouTube path is one HTTPS call
/// that can sit for thirty seconds or more while Gemini watches a video, and nothing
/// comes back until it is finished. Without stages, a UI can only show a spinner that
/// means "something is happening, possibly forever".
///
/// Stages are also the first thing to look at when a link *doesn't* work. "Stuck on
/// `analysing` for two minutes" and "never left `resolving`" are different bugs, and the
/// difference is visible from the outside only if the pipeline says which one it is.
public enum ExtractionStage: String, Sendable, Equatable, Codable, CaseIterable {
    /// Working out what the link points at: following short links, calling oEmbed,
    /// reading the embed page.
    case resolving
    /// Downloading the media file. ``IngestionStrategy/directMediaFetch`` only.
    case fetchingMedia
    /// Handing bytes to the Files API, for clips too large to send inline.
    case uploading
    /// The model is watching the video. Usually the longest stage by a wide margin,
    /// and the one that reports no interim progress of its own.
    case analysing
    /// Finished. Emitted once, after a `ClaimContext` exists.
    case done

    /// The stages a platform will actually pass through, in order.
    ///
    /// Lets a UI lay out the whole sequence up front and fill it in, rather than
    /// growing a list one row at a time — which reads as indecision.
    ///
    /// `uploading` is deliberately absent: whether a clip needs the Files API depends on
    /// its byte count, which isn't known until it has been downloaded. A stage that
    /// appears only sometimes is better inserted when it happens than shown greyed out
    /// and then skipped.
    public static func expected(for platform: Platform) -> [ExtractionStage] {
        switch platform.ingestionStrategy {
        case .nativeVideoIngestion:
            return [.resolving, .analysing, .done]
        case .directMediaFetch:
            return [.resolving, .fetchingMedia, .analysing, .done]
        case .screenCapture:
            return [.resolving, .fetchingMedia, .analysing, .done]
        }
    }
}

/// A progress event.
public struct ExtractionProgress: Sendable, Equatable {
    public var stage: ExtractionStage
    public var platform: Platform
    /// Something concrete about this step — a file size, a model name. Shown next to the
    /// label, never in place of it.
    public var detail: String?
    /// When the extraction as a whole began, so a UI can show elapsed time without
    /// keeping its own clock.
    public var startedAt: Date
    /// Monotonically increasing within one run, starting at 1.
    ///
    /// Events are *emitted* in order, but a consumer that forwards each one to another
    /// isolation domain with its own unstructured `Task` — the obvious way to get from
    /// the pipeline's executor to `@MainActor` — loses that ordering, because those
    /// tasks are not ordered relative to each other. The symptom is a stage list that
    /// jumps backwards.
    ///
    /// Comparing this against the last one applied makes the mistake harmless. See
    /// ``ExtractionPipeline/extract(from:onProgress:)``, whose documentation says how to
    /// avoid the situation entirely.
    public var sequence: Int

    public init(
        stage: ExtractionStage,
        platform: Platform,
        detail: String? = nil,
        startedAt: Date = Date(),
        sequence: Int = 0
    ) {
        self.stage = stage
        self.platform = platform
        self.detail = detail
        self.startedAt = startedAt
        self.sequence = sequence
    }

    /// User-facing description of what is happening.
    ///
    /// Lives here rather than in the view so it can be tested, and so a share extension,
    /// a widget and a debug log all say the same thing.
    public var label: String {
        switch stage {
        case .resolving:
            switch platform {
            case .youTube: return "Reading the YouTube link"
            case .tikTok: return "Finding the TikTok video"
            case .instagram: return "Finding the Instagram video"
            case .unknown: return "Reading the link"
            }
        case .fetchingMedia:
            return "Downloading the video"
        case .uploading:
            return "Uploading to Gemini"
        case .analysing:
            return "Analyzing your \(platform.displayName) video"
        case .done:
            return "Done"
        }
    }

    /// Why this stage can take a while. Shown when one overruns, so a slow step reads as
    /// slow rather than as broken.
    public var explanation: String? {
        switch stage {
        case .resolving: return nil
        case .fetchingMedia: return "Fetching the clip from \(platform.displayName)."
        case .uploading: return "This clip is large enough to need an upload first."
        case .analysing:
            return "Gemini is watching the video end to end. Long videos take longer."
        case .done: return nil
        }
    }

    /// How long this stage may reasonably run before a UI should reassure the user.
    ///
    /// Not a timeout — nothing is cancelled when it passes. Purely the point at which
    /// silence stops being normal and the interface should say something.
    public var patienceThreshold: TimeInterval {
        switch stage {
        case .resolving: return 4
        case .fetchingMedia: return 8
        case .uploading: return 15
        case .analysing: return 12
        case .done: return .infinity
        }
    }
}

extension Platform {
    /// The platform's name as a user would write it.
    public var displayName: String {
        switch self {
        case .youTube: return "YouTube"
        case .tikTok: return "TikTok"
        case .instagram: return "Instagram"
        case .unknown: return "video"
        }
    }
}

/// Where extractors send progress.
///
/// A plain struct around an optional closure rather than a protocol or an actor: this is
/// called a handful of times per extraction from inside `async` code, and it must be
/// usable from any isolation domain without introducing a suspension point. Constructing
/// one with no handler makes every `send` a no-op, so extractors need no `if progress !=
/// nil` branches.
public struct ProgressSink: Sendable {
    public typealias Handler = @Sendable (ExtractionProgress) -> Void

    /// Numbers events so a consumer can detect reordering it introduced itself.
    /// A reference type because the sink is a struct copied across `async` calls, and
    /// all copies of one run's sink have to share a counter.
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func next() -> Int {
            lock.lock()
            defer { lock.unlock() }
            value += 1
            return value
        }
    }

    private let handler: Handler?
    private let platform: Platform
    private let startedAt: Date
    private let counter: Counter

    public init(platform: Platform, startedAt: Date = Date(), handler: Handler? = nil) {
        self.platform = platform
        self.startedAt = startedAt
        self.handler = handler
        self.counter = Counter()
    }

    /// A sink that drops everything. The default, so progress reporting is opt-in for
    /// callers and free for the ones that don't want it.
    public static let ignored = ProgressSink(platform: .unknown, handler: nil)

    /// Called synchronously from the extractor, so events leave here in order.
    public func send(_ stage: ExtractionStage, detail: String? = nil) {
        guard let handler else { return }
        handler(
            ExtractionProgress(
                stage: stage,
                platform: platform,
                detail: detail,
                startedAt: startedAt,
                sequence: counter.next()
            )
        )
    }
}
