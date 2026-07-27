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
    public func extract(from url: URL) async throws -> ClaimContext {
        guard let extractor = extractor(for: url) else {
            throw ExtractionError.unsupportedPlatform(host: url.host)
        }
        let context = try await extractor.extract(from: url)
        guard !context.isEmpty else {
            throw ExtractionError.emptyResult(
                reason: "\(extractor.platform.rawValue) returned no transcript, text or frames"
            )
        }
        return context
    }
}
