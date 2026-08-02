import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Uploads media to the Gemini Files API and waits for it to become usable.
///
/// ## Why not always inline
///
/// `generateContent` accepts media inline as base64, which is one request and no state
/// — much the simpler path, and what ``GeminiVideoClient/analyzeInlineMedia(_:mimeType:)``
/// does. But the whole request must stay under 20 MB, and base64 inflates bytes by a
/// third, so the real ceiling is about 14 MB of video. A 10-second TikTok is ~3 MB; a
/// minute of it is not. Anything past the threshold has to go through Files.
///
/// Files also has a property worth having on the larger clips: the upload is a separate
/// request from the analysis, so a model fallback that retries `generateContent` reuses
/// the uploaded file rather than re-sending the bytes to each model in the chain.
///
/// ## Protocol
///
/// A three-step resumable upload, driven by `X-Goog-Upload-*` headers rather than a
/// request body:
///
/// 1. `POST /upload/v1beta/files` with `command: start` → session URL in a response header
/// 2. `POST <session URL>` with `command: upload, finalize` and the bytes → file metadata
/// 3. `GET /v1beta/files/<name>` until `state` leaves `PROCESSING`
///
/// Step 3 is not optional for video: the API returns immediately with `state: PROCESSING`
/// and referencing the file before it turns `ACTIVE` fails the generate call.
///
/// Uploaded files are deleted by Google after 48 hours, which is why nothing here tries
/// to cache or reuse a URI across runs.
public struct GeminiFilesClient: Sendable {
    private let transport: any HTTPTransport
    private let secrets: any SecretStore
    private let policy: RetryPolicy
    private let sleeper: any Sleeper
    private let baseURL: URL
    private let uploadURL: URL
    private let pollInterval: TimeInterval
    private let maxPollWait: TimeInterval

    public init(
        transport: any HTTPTransport = URLSessionTransport.videoUnderstanding(),
        secrets: any SecretStore,
        policy: RetryPolicy = .videoUnderstanding,
        sleeper: any Sleeper = TaskSleeper(),
        baseURL: URL = URL(string: "https://generativelanguage.googleapis.com/v1beta")!,
        uploadURL: URL = URL(string: "https://generativelanguage.googleapis.com/upload/v1beta/files")!,
        pollInterval: TimeInterval = 2,
        maxPollWait: TimeInterval = 120
    ) {
        self.transport = transport
        self.secrets = secrets
        self.policy = policy
        self.sleeper = sleeper
        self.baseURL = baseURL
        self.uploadURL = uploadURL
        self.pollInterval = pollInterval
        self.maxPollWait = maxPollWait
    }

    /// A file the API is holding for us.
    public struct UploadedFile: Sendable, Equatable {
        /// Resource name, e.g. `files/abc123`.
        public var name: String
        /// The URI to reference in a `file_data` part.
        public var uri: String
        public var mimeType: String
        public var state: String

        public var isActive: Bool { state.uppercased() == "ACTIVE" }
        public var isProcessing: Bool { state.uppercased() == "PROCESSING" }
    }

    /// Upload `data` and return once the API reports it usable.
    public func upload(
        _ data: Data,
        mimeType: String,
        displayName: String = "seer-capture"
    ) async throws -> UploadedFile {
        let apiKey = try secrets.requireSecret(named: .geminiAPIKey)
        let session = try await startSession(
            byteCount: data.count, mimeType: mimeType, displayName: displayName, apiKey: apiKey
        )
        let file = try await finalize(session: session, data: data, apiKey: apiKey)
        return try await waitUntilActive(file, apiKey: apiKey)
    }

    /// Removes a file we uploaded. Best-effort: Google expires these after 48 hours
    /// anyway, so a failure here is not worth surfacing over a successful analysis.
    public func delete(_ file: UploadedFile) async {
        guard let apiKey = try? secrets.requireSecret(named: .geminiAPIKey) else { return }
        var request = URLRequest(url: baseURL.appendingPathComponent(file.name))
        request.httpMethod = "DELETE"
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        _ = try? await transport.send(request)
    }

    // MARK: - Steps

    private func startSession(
        byteCount: Int, mimeType: String, displayName: String, apiKey: String
    ) async throws -> URL {
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        request.setValue("resumable", forHTTPHeaderField: "X-Goog-Upload-Protocol")
        request.setValue("start", forHTTPHeaderField: "X-Goog-Upload-Command")
        request.setValue(String(byteCount), forHTTPHeaderField: "X-Goog-Upload-Header-Content-Length")
        request.setValue(mimeType, forHTTPHeaderField: "X-Goog-Upload-Header-Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(StartRequest(file: .init(displayName: displayName)))

        let client = RetryingHTTPClient(
            transport: transport, policy: policy, serviceName: "Gemini Files", sleeper: sleeper
        )
        let (_, response) = try await client.sendReturningResponse(request)

        // Header lookup is case-insensitive on Darwin but not on
        // swift-corelibs-foundation, so try both spellings rather than assume.
        let raw = response.value(forHTTPHeaderField: "X-Goog-Upload-URL")
            ?? response.value(forHTTPHeaderField: "x-goog-upload-url")
        guard let raw, let sessionURL = URL(string: raw) else {
            throw ExtractionError.malformedResponse(
                "Gemini Files did not return an upload URL"
            )
        }
        return sessionURL
    }

    private func finalize(session: URL, data: Data, apiKey: String) async throws -> UploadedFile {
        var request = URLRequest(url: session)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        request.setValue(String(data.count), forHTTPHeaderField: "Content-Length")
        request.setValue("0", forHTTPHeaderField: "X-Goog-Upload-Offset")
        // One shot: send everything and close the session in the same request. Chunked
        // resume would matter for a multi-gigabyte upload; a clip that has already been
        // capped at tens of megabytes is cheaper to simply retry.
        request.setValue("upload, finalize", forHTTPHeaderField: "X-Goog-Upload-Command")
        request.httpBody = data

        let client = RetryingHTTPClient(
            transport: transport, policy: policy, serviceName: "Gemini Files", sleeper: sleeper
        )
        return try Self.parseFile(try await client.send(request))
    }

    /// Polls with a short first wait that ramps up to `pollInterval`, bounded by
    /// `maxPollWait` on the clock.
    ///
    /// A flat cadence is the right interval for a slow transcode and the wrong one for
    /// the file this app actually uploads: a short-form clip is typically ready within a
    /// few hundred milliseconds of finalizing, and a flat interval cannot discover that
    /// sooner than its own length — so the fast case paid the interval in full, every
    /// time, on the critical path before the model had even been called. Starting short
    /// and backing off catches it almost immediately while a genuinely slow transcode
    /// still settles to the same lazy cadence instead of hammering the API.
    ///
    /// The ceiling is a duration rather than a poll count for the same reason the web
    /// implementation's is: once the interval varies, a count of polls no longer
    /// describes how long anything waits, and the bound that matters is the clock.
    private func waitUntilActive(_ file: UploadedFile, apiKey: String) async throws -> UploadedFile {
        var current = file
        var interval = min(0.25, pollInterval)
        let deadline = Date().addingTimeInterval(maxPollWait)

        while true {
            if current.isActive { return current }
            guard current.isProcessing else {
                throw ExtractionError.upstreamFailure(
                    service: "Gemini Files", status: nil,
                    message: "upload finished in state \(current.state)"
                )
            }
            try Task.checkCancellation()

            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { throw ExtractionError.timedOut(after: maxPollWait) }
            try await sleeper.sleep(for: min(interval, remaining))
            interval = min(interval * 1.6, pollInterval)

            var request = URLRequest(url: baseURL.appendingPathComponent(current.name))
            request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
            let client = RetryingHTTPClient(
                transport: transport, policy: .metadata, serviceName: "Gemini Files", sleeper: sleeper
            )
            current = try Self.parseFile(try await client.send(request))
        }
    }

    // MARK: - Wire

    private struct StartRequest: Encodable {
        var file: FileBody
        struct FileBody: Encodable {
            var displayName: String
            enum CodingKeys: String, CodingKey { case displayName = "display_name" }
        }
    }

    /// Both the finalize response and the poll response carry the same object, but the
    /// former nests it under `file` and the latter returns it bare.
    static func parseFile(_ data: Data) throws -> UploadedFile {
        struct Envelope: Decodable {
            var file: FileBody?
            var name: String?
            var uri: String?
            var mimeType: String?
            var state: String?
        }
        struct FileBody: Decodable {
            var name: String?
            var uri: String?
            var mimeType: String?
            var state: String?
        }

        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else {
            throw ExtractionError.malformedResponse("Gemini Files response was not JSON")
        }
        let name = envelope.file?.name ?? envelope.name
        let uri = envelope.file?.uri ?? envelope.uri
        let mimeType = envelope.file?.mimeType ?? envelope.mimeType
        let state = envelope.file?.state ?? envelope.state

        guard let name, let uri else {
            throw ExtractionError.malformedResponse("Gemini Files response carried no file name or URI")
        }
        return UploadedFile(
            name: name,
            uri: uri,
            mimeType: mimeType ?? "video/mp4",
            // Absent state means the file is ready; only video reports PROCESSING.
            state: state ?? "ACTIVE"
        )
    }
}
