import Foundation

/// Exponential backoff with full jitter.
///
/// Full jitter (sleep a random amount in `[0, cap]`) rather than fixed backoff:
/// share-extension launches cluster — a user pastes three links in a row, or a whole
/// cohort hits a rate limit at once — and unjittered retries just reconverge on the
/// same instant.
public struct RetryPolicy: Sendable, Equatable {
    /// Number of *retries* after the first attempt. `maxRetries: 3` means up to 4 calls.
    public var maxRetries: Int
    public var baseDelay: TimeInterval
    public var maxDelay: TimeInterval
    /// Ceiling on the whole operation, retries included.
    public var overallTimeout: TimeInterval

    public init(
        maxRetries: Int = 3,
        baseDelay: TimeInterval = 1.0,
        maxDelay: TimeInterval = 16.0,
        overallTimeout: TimeInterval = 180
    ) {
        self.maxRetries = maxRetries
        self.baseDelay = baseDelay
        self.maxDelay = maxDelay
        self.overallTimeout = overallTimeout
    }

    /// Tuned for Gemini video calls, which are slow by nature — a few minutes of
    /// video takes real wall-clock time to process.
    public static let videoUnderstanding = RetryPolicy(
        maxRetries: 3, baseDelay: 2, maxDelay: 30, overallTimeout: 300
    )

    /// Tuned for small, fast JSON calls (oEmbed, metadata).
    public static let metadata = RetryPolicy(
        maxRetries: 2, baseDelay: 0.5, maxDelay: 4, overallTimeout: 20
    )

    /// Delay before retry number `attempt` (1-based), ignoring server guidance.
    public func delay(forAttempt attempt: Int, randomness: Double = Double.random(in: 0...1)) -> TimeInterval {
        guard attempt > 0 else { return 0 }
        let exponential = baseDelay * pow(2, Double(attempt - 1))
        let capped = min(exponential, maxDelay)
        return capped * max(0, min(1, randomness))
    }
}

/// How a failed attempt should be handled.
public enum RetryDecision: Equatable, Sendable {
    case retry(after: TimeInterval?)
    case fail
}

/// Classifies an HTTP status into retry/fail.
///
/// - 408/429 and 5xx are transient.
/// - 404 is *not* retried: on the Gemini path it means "no such model", which is a
///   signal to fall through to the next model in the chain rather than to wait.
/// - Other 4xx are our fault and won't improve with time.
public func retryDecision(forStatus status: Int, retryAfter: TimeInterval?) -> RetryDecision {
    switch status {
    case 408, 429:
        return .retry(after: retryAfter)
    case 500...599:
        return .retry(after: retryAfter)
    default:
        return .fail
    }
}

/// Whether a transport-level error is worth another go. Cancellation never is.
public func isRetryableTransportError(_ error: Error) -> Bool {
    if error is CancellationError { return false }
    let nsError = error as NSError
    guard nsError.domain == NSURLErrorDomain else { return false }
    switch nsError.code {
    case NSURLErrorTimedOut,
         NSURLErrorCannotFindHost,
         NSURLErrorCannotConnectToHost,
         NSURLErrorNetworkConnectionLost,
         NSURLErrorDNSLookupFailed,
         NSURLErrorNotConnectedToInternet,
         NSURLErrorSecureConnectionFailed:
        return true
    default:
        return false
    }
}
