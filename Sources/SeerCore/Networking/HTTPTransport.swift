import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Seam between the clients and the network, so the pipeline can be exercised in
/// tests without a live endpoint.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)

    /// Send, refusing to hold more than `maxBytes` of response body in memory.
    ///
    /// Distinct from checking `data.count` after ``send(_:)`` returns, which is what the
    /// media downloader used to do: by then the allocation the ceiling exists to prevent
    /// has already happened. Every other call in this pipeline is a small JSON body, so
    /// this is a requirement with a default rather than the primary method — only the
    /// media path needs it.
    func send(_ request: URLRequest, maxBytes: Int) async throws -> (Data, HTTPURLResponse)
}

extension HTTPTransport {
    /// Buffer first, then check — the behaviour a transport gets when it has no bounded
    /// path of its own.
    ///
    /// This does **not** bound the allocation; it only stops an oversized body being
    /// passed downstream to be base64-encoded and uploaded. Conformances that can do
    /// better should say so, and ``URLSessionTransport`` does. Test doubles keep this,
    /// which is what makes their fixtures behave the same as before.
    public func send(_ request: URLRequest, maxBytes: Int) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await send(request)
        try Self.checkSize(data.count, against: maxBytes)
        return (data, response)
    }

    static func checkSize(_ byteCount: Int, against maxBytes: Int) throws {
        guard byteCount > maxBytes else { return }
        throw ExtractionError.emptyResult(
            reason: "media file is \(byteCount / 1_048_576) MB, over the \(maxBytes / 1_048_576) MB limit"
        )
    }
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

    #if canImport(Darwin)
    /// Streams the body to a temporary file, checks its size, and only then reads it in.
    ///
    /// The point is where the bytes accumulate. `data(for:)` builds the whole body in
    /// memory before anything can inspect it, so a ceiling applied afterwards cannot stop
    /// a share extension being killed for the allocation — the process is already dead or
    /// it isn't. Downloading to disk moves the unbounded part onto storage, which is not
    /// what jetsam counts, and keeps the in-memory copy bounded by `maxBytes`.
    ///
    /// What this deliberately does not do is abort mid-transfer: an oversized file is
    /// pulled down in full before being rejected. Cancelling on the first chunk past the
    /// ceiling needs a `URLSessionDataDelegate`, and the bandwidth saved is not worth that
    /// machinery while the ceiling exists to protect memory rather than the network.
    ///
    /// Darwin only. `swift-corelibs-foundation` does not carry the async `download(for:)`,
    /// and Linux is CI rather than a place this ships, so it keeps the buffered default.
    public func send(_ request: URLRequest, maxBytes: Int) async throws -> (Data, HTTPURLResponse) {
        let (fileURL, response) = try await session.download(for: request)
        defer { try? FileManager.default.removeItem(at: fileURL) }

        guard let http = response as? HTTPURLResponse else {
            throw ExtractionError.malformedResponse("non-HTTP response")
        }
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let size = attributes[.size] as? Int
        else {
            throw ExtractionError.malformedResponse("could not size the downloaded file")
        }
        try Self.checkSize(size, against: maxBytes)

        let data = try Data(contentsOf: fileURL)
        return (data, http)
    }
    #endif
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
        try await sendReturningResponse(request).0
    }

    /// As ``send(_:)``, bounded. See ``HTTPTransport/send(_:maxBytes:)``.
    public func send(_ request: URLRequest, maxBytes: Int) async throws -> Data {
        try await sendReturningResponse(request, maxBytes: maxBytes).0
    }

    /// As ``send(_:)``, but hands back the response too.
    ///
    /// Needed by the callers that read something other than the body: Gemini's resumable
    /// upload returns its session URL in a header, and short-link resolution reads the
    /// post-redirect `URLResponse.url`.
    /// - Parameter maxBytes: when set, the body is bounded as it is received rather than
    ///   checked afterwards. Only the media path passes this; everything else here is a
    ///   small JSON body.
    public func sendReturningResponse(
        _ request: URLRequest, maxBytes: Int? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        let deadline = Date().addingTimeInterval(policy.overallTimeout)
        var lastError: Error?

        for attempt in 0...policy.maxRetries {
            try Task.checkCancellation()

            if Date() >= deadline {
                throw lastError ?? ExtractionError.timedOut(after: policy.overallTimeout)
            }

            do {
                let data: Data
                let response: HTTPURLResponse
                if let maxBytes {
                    (data, response) = try await transport.send(request, maxBytes: maxBytes)
                } else {
                    (data, response) = try await transport.send(request)
                }
                if (200..<300).contains(response.statusCode) {
                    return (data, response)
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
        // Trimmed once and used for both forms. Previously only the numeric parse saw
        // the trimmed value, so a well-formed HTTP-date arriving with surrounding
        // whitespace parsed as neither and the server's guidance was silently dropped.
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if let seconds = TimeInterval(trimmed) { return seconds }

        // The header also permits an HTTP-date. Built per call rather than cached in a
        // `static`: `DateFormatter` is not `Sendable`, and this type is, so a shared
        // instance would need `nonisolated(unsafe)` to satisfy strict concurrency. Not
        // worth it on a path that is already about to sleep for seconds.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: trimmed) else { return nil }
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
