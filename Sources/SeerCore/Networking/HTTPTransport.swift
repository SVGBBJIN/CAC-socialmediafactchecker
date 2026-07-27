import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Seam between the clients and the network, so the pipeline can be exercised in
/// tests without a live endpoint.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// Suspends between retries. Injected so tests don't spend real seconds asleep.
public protocol Sleeper: Sendable {
    func sleep(for duration: TimeInterval) async throws
}

public struct TaskSleeper: Sleeper {
    public init() {}
    public func sleep(for duration: TimeInterval) async throws {
        guard duration > 0 else { return }
        try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
    }
}

/// Records the delays it was asked for and returns immediately, so a test can assert
/// on backoff behaviour without spending the wall-clock time.
public actor ImmediateSleeper: Sleeper {
    public private(set) var recorded: [TimeInterval] = []
    public init() {}
    public func sleep(for duration: TimeInterval) async throws {
        recorded.append(duration)
    }
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    /// A session with timeouts suited to long video calls. The default 60s request
    /// timeout will cut off a Gemini call on a multi-minute video.
    public static func videoUnderstanding() -> URLSessionTransport {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        #if canImport(Darwin)
        // Not settable on swift-corelibs-foundation; only affects the Apple targets.
        config.waitsForConnectivity = true
        #endif
        return URLSessionTransport(session: URLSession(configuration: config))
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ExtractionError.malformedResponse("non-HTTP response")
        }
        return (data, http)
    }
}

/// Wraps a transport with the retry policy.
public struct RetryingHTTPClient: Sendable {
    private let transport: any HTTPTransport
    private let policy: RetryPolicy
    private let sleeper: any Sleeper
    private let serviceName: String

    public init(
        transport: any HTTPTransport,
        policy: RetryPolicy,
        serviceName: String,
        sleeper: any Sleeper = TaskSleeper()
    ) {
        self.transport = transport
        self.policy = policy
        self.serviceName = serviceName
        self.sleeper = sleeper
    }

    /// Send, retrying transient failures. Non-2xx responses that aren't retryable are
    /// thrown as ``ExtractionError/upstreamFailure``, so callers can inspect `status`
    /// — the Gemini client uses a 404 to fall through to the next model.
    public func send(_ request: URLRequest) async throws -> Data {
        let deadline = Date().addingTimeInterval(policy.overallTimeout)
        var lastError: Error?

        for attempt in 0...policy.maxRetries {
            try Task.checkCancellation()

            if Date() >= deadline {
                throw lastError ?? ExtractionError.timedOut(after: policy.overallTimeout)
            }

            do {
                let (data, response) = try await transport.send(request)
                if (200..<300).contains(response.statusCode) {
                    return data
                }

                let message = Self.errorMessage(from: data, status: response.statusCode)
                let failure = ExtractionError.upstreamFailure(
                    service: serviceName, status: response.statusCode, message: message
                )

                let retryAfter = Self.retryAfterSeconds(from: response)
                guard case .retry(let serverDelay) = retryDecision(
                    forStatus: response.statusCode, retryAfter: retryAfter
                ), attempt < policy.maxRetries else {
                    throw failure
                }
                lastError = failure
                try await waitBeforeRetry(attempt: attempt + 1, serverDelay: serverDelay, deadline: deadline)
            } catch let error as ExtractionError {
                throw error
            } catch {
                guard isRetryableTransportError(error), attempt < policy.maxRetries else { throw error }
                lastError = error
                try await waitBeforeRetry(attempt: attempt + 1, serverDelay: nil, deadline: deadline)
            }
        }

        throw lastError ?? ExtractionError.timedOut(after: policy.overallTimeout)
    }

    private func waitBeforeRetry(attempt: Int, serverDelay: TimeInterval?, deadline: Date) async throws {
        // Honour Retry-After when the server sends one; it knows more than our curve
        // does. Still clamp it, so a hostile or absurd value can't park the share
        // extension for an hour.
        let backoff = policy.delay(forAttempt: attempt)
        let delay = min(max(serverDelay ?? backoff, 0), policy.maxDelay)
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw ExtractionError.timedOut(after: policy.overallTimeout) }
        try await sleeper.sleep(for: min(delay, remaining))
    }

    static func retryAfterSeconds(from response: HTTPURLResponse) -> TimeInterval? {
        guard let raw = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
        if let seconds = TimeInterval(raw.trimmingCharacters(in: .whitespaces)) { return seconds }
        // The header also permits an HTTP-date.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: raw) else { return nil }
        return max(0, date.timeIntervalSinceNow)
    }

    /// Pull a human-readable message out of an error body, without assuming a shape.
    static func errorMessage(from data: Data, status: Int) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let error = object["error"] as? [String: Any],
               let message = error["message"] as? String {
                return message
            }
            if let message = object["message"] as? String { return message }
        }
        let body = String(data: data.prefix(500), encoding: .utf8) ?? ""
        return body.isEmpty ? "HTTP \(status)" : body
    }
}
