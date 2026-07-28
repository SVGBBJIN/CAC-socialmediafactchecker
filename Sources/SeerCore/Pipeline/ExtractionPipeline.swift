import Foundation

/// The share-extension entry point.
///
/// Hand it a URL, get a ``ClaimContext``. Routing across the ingestion fork happens
/// here and nowhere else.
public struct ExtractionPipeline: Sendable {
    private let extractors: [any ClaimExtractor]

    public init(extractors: [any ClaimExtractor]) {
        self.extractors = extractors
        #if DEBUG
        for extractor in extractors where extractor.strategy != extractor.platform.ingestionStrategy {
            assertionFailure(
                """
                \(type(of: extractor)) declares strategy \(extractor.strategy.rawValue) but \
                \(extractor.platform.rawValue).ingestionStrategy is \
                \(extractor.platform.ingestionStrategy.rawValue). The fork is defined on \
                Platform — change it there, not on the extractor.
                """
            )
        }
        #endif
    }

    /// The extractor that will handle this URL, if any. Useful for showing the user
    /// what's about to happen (the capture path needs a recording prompt) before
    /// committing to it.
    public func extractor(for url: URL) -> (any ClaimExtractor)? {
        extractors.first { $0.canHandle(url) }
    }

    /// Resolve a shared URL into the shared context shape.
    ///
    /// - Parameter onProgress: called as the extraction moves between stages, **called
    ///   synchronously on whatever executor the pipeline is running on**. Events leave
    ///   in order.
    ///
    ///   Keeping them in order is the caller's problem, and there is a trap here worth
    ///   naming. The obvious way to drive a UI —
    ///
    ///   ```swift
    ///   try await pipeline.extract(from: url) { p in
    ///       Task { @MainActor in model.apply(p) }   // ← reorders
    ///   }
    ///   ```
    ///
    ///   — spawns one unstructured task per event, and those tasks are unordered
    ///   relative to each other, so stages can arrive backwards. Either yield into an
    ///   `AsyncStream` and consume it with `for await` (what `AnalysisModel` in `SeerUI`
    ///   does), or compare ``ExtractionProgress/sequence`` and drop anything stale.
    public func extract(
        from url: URL,
        onProgress: ProgressSink.Handler? = nil
    ) async throws -> ClaimContext {
        guard let extractor = extractor(for: url) else {
            throw ExtractionError.unsupportedPlatform(host: url.host)
        }

        // One clock for the whole run, set before any work starts, so elapsed time in
        // the UI matches how long the user has actually been waiting.
        let sink = ProgressSink(platform: extractor.platform, handler: onProgress)

        let context = try await extractor.extract(from: url, progress: sink)
        guard !context.isEmpty else {
            throw ExtractionError.emptyResult(
                reason: "\(extractor.platform.rawValue) returned no transcript, text or frames"
            )
        }
        // Emitted here rather than inside each extractor: `done` means the pipeline
        // accepted the result, and an extraction that returns an empty context has not
        // finished successfully however far it got.
        sink.send(.done)
        return context
    }
}
