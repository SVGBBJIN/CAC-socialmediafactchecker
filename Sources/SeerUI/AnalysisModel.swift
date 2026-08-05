#if canImport(SwiftUI)
import Foundation
import Observation
import SeerCore

/// Drives an extraction and publishes what stage it is at.
///
/// The pipeline calls its progress handler from whatever executor it happens to be on,
/// so every mutation hops to the main actor here. That hop is the reason this type
/// exists rather than the view observing the pipeline directly.
@MainActor
@Observable
public final class AnalysisModel {
    /// One step in the run, and how it went.
    public struct Step: Identifiable, Sendable, Equatable {
        public var stage: ExtractionStage
        public var detail: String?
        /// When this step began. Nil until it does.
        public var startedAt: Date?
        /// How long it took. Nil while running or not yet started.
        public var duration: TimeInterval?

        public var id: String { stage.rawValue }
        public var hasStarted: Bool { startedAt != nil }
        public var isFinished: Bool { duration != nil }
    }

    public enum State: Equatable {
        case idle
        case running
        case finished
        /// The run was cancelled by the caller. Distinct from ``failed`` on purpose: a
        /// `CancellationError` falling into the failure path gets rendered through
        /// `localizedDescription`, which produces "The operation couldn't be completed.
        /// (Swift.CancellationError error 1.)" as the headline the user reads — an
        /// internal error string presented as the outcome of an action they chose.
        case cancelled
        case failed(String)

        /// Whether anything is still moving. The view keys its clock off this, so a
        /// settled run stops driving redraws.
        public var isActive: Bool { self == .running }
    }

    public private(set) var state: State = .idle
    public private(set) var platform: Platform = .unknown
    /// Every step, in the order they will happen — including ones not yet reached, so
    /// the list doesn't jump as it fills in.
    public private(set) var steps: [Step] = []
    public private(set) var currentStage: ExtractionStage?
    public private(set) var startedAt: Date?
    public private(set) var result: ClaimContext?

    private let pipeline: ExtractionPipeline
    private var lastAppliedSequence = 0

    public init(pipeline: ExtractionPipeline) {
        self.pipeline = pipeline
    }

    /// The step being worked on now.
    public var currentStep: Step? {
        guard let currentStage else { return nil }
        return steps.first { $0.stage == currentStage }
    }

    /// How long the whole run has been going.
    public func elapsed(at now: Date = Date()) -> TimeInterval {
        guard let startedAt else { return 0 }
        return max(0, now.timeIntervalSince(startedAt))
    }

    /// Whether the current step has run long enough that silence needs explaining.
    ///
    /// This is the whole point of the exercise: a Gemini call on a long video can sit
    /// for well over a minute, and an interface that says nothing for that long is
    /// indistinguishable from one that has crashed.
    public func needsReassurance(at now: Date = Date()) -> Bool {
        guard state == .running, let step = currentStep, let stageStart = step.startedAt
        else { return false }
        let progress = ExtractionProgress(stage: step.stage, platform: platform)
        return now.timeIntervalSince(stageStart) > progress.patienceThreshold
    }

    /// Text for the current stage, ready to display.
    public var label: String {
        switch state {
        case .idle: return "Paste a link to begin"
        case .finished: return "Done"
        case .cancelled: return "Cancelled"
        case .failed(let message): return message
        case .running:
            guard let currentStage else { return "Starting…" }
            return ExtractionProgress(stage: currentStage, platform: platform).label
        }
    }

    /// Why the current stage is slow, once it has been slow for a while.
    public func explanation(at now: Date = Date()) -> String? {
        guard needsReassurance(at: now), let currentStage else { return nil }
        return ExtractionProgress(stage: currentStage, platform: platform).explanation
    }

    /// Run an extraction, publishing progress as it goes.
    ///
    /// The pipeline calls its handler synchronously, off the main actor. Forwarding each
    /// event with its own `Task { @MainActor in … }` would be the obvious bridge and is
    /// wrong — those tasks are unordered, so the stage list can jump backwards. Yielding
    /// into an `AsyncStream` and consuming it with `for await` keeps the order, because
    /// the stream buffers in order and the loop processes one at a time.
    @discardableResult
    public func analyse(_ url: URL) async -> ClaimContext? {
        // One model, one run. Two concurrent `analyse` calls would share `steps`,
        // `currentStage` and `lastAppliedSequence`, so the second run's first event
        // (sequence 1) loses the `sequence > lastAppliedSequence` test against the
        // first run's progress and is silently dropped — the second run then renders
        // as permanently stuck on whatever stage the first one had reached.
        guard state != .running else { return nil }
        prepare(for: url)

        let (stream, continuation) = AsyncStream<ExtractionProgress>.makeStream()
        let consumer = Task { @MainActor [weak self] in
            for await progress in stream { self?.apply(progress) }
        }

        do {
            let context = try await pipeline.extract(from: url) { progress in
                continuation.yield(progress)
            }
            continuation.finish()
            // Drain before publishing the result, so the final stage is never still
            // pending when the view switches to its finished state.
            await consumer.value
            finish(with: context)
            return context
        } catch {
            continuation.finish()
            await consumer.value
            fail(with: error)
            return nil
        }
    }

    // MARK: - State transitions

    /// The sequence a platform will pass through, as unstarted rows.
    ///
    /// Laid out in full up front so rows don't appear one at a time, which reads as the
    /// app deciding what to do as it goes.
    private static func plannedSteps(for platform: Platform) -> [Step] {
        ExtractionStage.expected(for: platform)
            .filter { $0 != .done }
            .map { Step(stage: $0) }
    }

    private func prepare(for url: URL) {
        platform = Platform.detect(from: url)
        steps = Self.plannedSteps(for: platform)
        currentStage = nil
        result = nil
        startedAt = Date()
        lastAppliedSequence = 0
        state = .running
    }

    private func apply(_ progress: ExtractionProgress) {
        guard state == .running else { return }
        // Belt and braces. The stream above already preserves order; this makes the
        // model correct even if a future caller wires it up the naive way.
        guard progress.sequence > lastAppliedSequence else { return }
        lastAppliedSequence = progress.sequence

        // The pipeline builds its sink from `extractor.platform`, which is the extractor
        // that actually claimed the URL — not necessarily what `Platform.detect` guessed
        // from the host in `prepare`. When the two disagree the laid-out step list belongs
        // to the wrong ingestion strategy: a run routed to `directMediaFetch` would show
        // the `screenCapture` sequence and never fill in the row it is actually on. Relay
        // the list out to match, but only on a genuine change and only while no step has
        // begun, so this can't disturb rows the user is already watching.
        if progress.platform != platform {
            platform = progress.platform
            if !steps.contains(where: { $0.hasStarted }) {
                steps = Self.plannedSteps(for: platform)
            }
        }
        startedAt = progress.startedAt

        guard progress.stage != .done else { return }

        let now = Date()
        closeCurrentStep(at: now)

        // `uploading` only happens for clips too large to send inline, which isn't known
        // until the bytes are in hand — so it is inserted when it occurs rather than
        // shown up front and then skipped.
        if let index = steps.firstIndex(where: { $0.stage == progress.stage }) {
            steps[index].startedAt = now
            steps[index].detail = progress.detail ?? steps[index].detail
        } else {
            let step = Step(stage: progress.stage, detail: progress.detail, startedAt: now)
            let insertAt = steps.firstIndex { $0.stage == .analysing } ?? steps.endIndex
            steps.insert(step, at: insertAt)
        }
        currentStage = progress.stage
    }

    private func closeCurrentStep(at now: Date) {
        guard let currentStage,
              let index = steps.firstIndex(where: { $0.stage == currentStage }),
              let started = steps[index].startedAt,
              steps[index].duration == nil
        else { return }
        steps[index].duration = now.timeIntervalSince(started)
    }

    private func finish(with context: ClaimContext) {
        closeCurrentStep(at: Date())
        currentStage = nil
        result = context
        state = .finished
    }

    private func fail(with error: Error) {
        closeCurrentStep(at: Date())
        currentStage = nil
        // Cancellation is an outcome the user asked for, not a fault to report. It
        // arrives here as `CancellationError` (thrown by the `Task.checkCancellation()`
        // calls every extractor makes) or as `NSURLErrorCancelled` from a URLSession task
        // torn down mid-flight — both of which describe themselves in language written
        // for a crash log, not for the person who pressed Cancel.
        let nsError = error as NSError
        if error is CancellationError
            || (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled) {
            state = .cancelled
            return
        }
        let message = (error as? ExtractionError)?.errorDescription
            ?? error.localizedDescription
        state = .failed(message)
    }

    /// A plain-text breakdown of where the time went.
    ///
    /// The troubleshooting payoff of staging: "stuck on analysing for 90s" and "never
    /// left resolving" are different bugs, and this is what makes the difference legible
    /// after the fact — in a bug report, a log, or a debug sheet.
    public var timingReport: String {
        var lines: [String] = ["\(platform.displayName) — \(String(format: "%.1fs", elapsed()))"]
        for step in steps where step.hasStarted {
            let time = step.duration.map { String(format: "%.1fs", $0) } ?? "running…"
            let detail = step.detail.map { " (\($0))" } ?? ""
            lines.append("  \(step.stage.rawValue)\(detail): \(time)")
        }
        if case .failed(let message) = state { lines.append("  failed: \(message)") }
        return lines.joined(separator: "\n")
    }
}
#endif
