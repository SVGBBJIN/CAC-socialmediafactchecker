import Foundation

/// The one interface both sides of the ingestion fork conform to.
///
/// `ExtractionPipeline` holds a list of these and asks each one whether it can handle
/// a URL. Nothing above this protocol knows whether a `ClaimContext` was produced by
/// a model reading a URL or by a screen recording pushed through Whisper.
public protocol ClaimExtractor: Sendable {
    /// The platform this extractor serves.
    var platform: Platform { get }

    /// Which side of the fork this extractor sits on. Should agree with
    /// `platform.ingestionStrategy`; the pipeline asserts as much in debug builds.
    var strategy: IngestionStrategy { get }

    /// Whether this extractor will accept the URL. Beyond a host check, an extractor
    /// may decline URLs it recognises but can't process — a YouTube *channel* link,
    /// say, which has no video to ingest.
    func canHandle(_ url: URL) -> Bool

    /// Produce the shared context. Long-running; honours task cancellation.
    ///
    /// - Parameter progress: where to report stage changes. Pass
    ///   ``ProgressSink/ignored`` to discard them.
    func extract(from url: URL, progress: ProgressSink) async throws -> ClaimContext
}

extension ClaimExtractor {
    public var strategy: IngestionStrategy { platform.ingestionStrategy }

    /// Extract without reporting progress.
    public func extract(from url: URL) async throws -> ClaimContext {
        try await extract(from: url, progress: .ignored)
    }
}

/// Failures the extraction layer surfaces. Deliberately small — callers need to know
/// whether to retry, ask the user for something, or give up.
public enum ExtractionError: Error, Equatable, Sendable {
    /// No registered extractor accepted the URL.
    case unsupportedPlatform(host: String?)
    /// The URL is recognised but doesn't point at a piece of media.
    case notAMediaURL(URL)
    /// Upstream returned an error we can't recover from.
    case upstreamFailure(service: String, status: Int?, message: String)
    /// All configured models/endpoints were tried and none succeeded.
    case allCandidatesFailed(attempts: [String])
    /// A required credential wasn't available.
    case missingCredential(name: String)
    /// The response arrived but didn't parse into a usable shape.
    case malformedResponse(String)
    /// Extraction ran but produced nothing usable.
    case emptyResult(reason: String)
    /// Ran past its deadline.
    case timedOut(after: TimeInterval)
    /// A capability the pipeline needs isn't available on this device/build.
    case captureUnavailable(reason: String)
    /// The user declined a permission the path requires (screen recording).
    case permissionDenied(String)
}

extension ExtractionError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unsupportedPlatform(let host):
            return "Seer can't read links from \(host ?? "this site") yet."
        case .notAMediaURL:
            return "That link doesn't point to a video."
        case .upstreamFailure(let service, let status, let message):
            let code = status.map { " (\($0))" } ?? ""
            return "\(service) failed\(code): \(message)"
        case .allCandidatesFailed(let attempts):
            return "Every option failed: \(attempts.joined(separator: ", "))."
        case .missingCredential(let name):
            return "Missing credential: \(name)."
        case .malformedResponse(let detail):
            return "Unexpected response: \(detail)"
        case .emptyResult(let reason):
            return "Nothing to fact-check: \(reason)"
        case .timedOut(let after):
            return "Timed out after \(Int(after))s."
        case .captureUnavailable(let reason):
            return "Screen capture unavailable: \(reason)"
        case .permissionDenied(let what):
            return "Permission denied: \(what)"
        }
    }
}
