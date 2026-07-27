import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Turns recorded media into text.
public protocol Transcriber: Sendable {
    func transcribe(_ media: CapturedMedia) async throws -> Transcription
}

public struct Transcription: Sendable, Equatable {
    public var text: String
    /// Detected language, when the service reports one.
    public var language: String?
    /// Model that produced it, for diagnostics.
    public var model: String?

    public init(text: String, language: String? = nil, model: String? = nil) {
        self.text = text
        self.language = language
        self.model = model
    }
}

/// Whisper transcription via Groq's OpenAI-compatible endpoint.
public struct GroqWhisperTranscriber: Transcriber {
    private let transport: any HTTPTransport
    private let secrets: any SecretStore
    private let model: String
    private let policy: RetryPolicy
    private let sleeper: any Sleeper
    private let endpoint: URL

    public init(
        transport: any HTTPTransport = URLSessionTransport.videoUnderstanding(),
        secrets: any SecretStore,
        model: String = "whisper-large-v3-turbo",
        policy: RetryPolicy = RetryPolicy(maxRetries: 3, baseDelay: 1, maxDelay: 16, overallTimeout: 180),
        sleeper: any Sleeper = TaskSleeper(),
        endpoint: URL = URL(string: "https://api.groq.com/openai/v1/audio/transcriptions")!
    ) {
        self.transport = transport
        self.secrets = secrets
        self.model = model
        self.policy = policy
        self.sleeper = sleeper
        self.endpoint = endpoint
    }

    public func transcribe(_ media: CapturedMedia) async throws -> Transcription {
        guard media.containsAudio else {
            // Refuse rather than upload. A silent file returns an empty or hallucinated
            // transcript, and both are worse than a clear failure — an empty transcript
            // reads downstream as "this video makes no claims".
            throw ExtractionError.emptyResult(reason: "recording contained no audio")
        }
        guard !media.data.isEmpty else {
            throw ExtractionError.emptyResult(reason: "recording was empty")
        }

        let apiKey = try secrets.requireSecret(named: .groqAPIKey)
        let boundary = "seer-\(UUID().uuidString)"

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.multipartBody(
            boundary: boundary,
            media: media,
            fields: [
                "model": model,
                "response_format": "verbose_json",
                // Whisper fills silence with plausible-sounding text when it has nothing
                // to work with. Temperature 0 curbs it; `containsAudio` above is the
                // real defence.
                "temperature": "0",
            ]
        )

        let client = RetryingHTTPClient(
            transport: transport, policy: policy, serviceName: "Groq Whisper", sleeper: sleeper
        )
        let data = try await client.send(request)
        return try Self.parse(data, model: model)
    }

    static func multipartBody(
        boundary: String,
        media: CapturedMedia,
        fields: [String: String]
    ) -> Data {
        var body = Data()
        func append(_ string: String) { body.append(Data(string.utf8)) }

        // Sorted so the body is deterministic and testable.
        for (name, value) in fields.sorted(by: { $0.key < $1.key }) {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            append("\(value)\r\n")
        }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(Self.filename(for: media.mimeType))\"\r\n")
        append("Content-Type: \(media.mimeType)\r\n\r\n")
        body.append(media.data)
        append("\r\n--\(boundary)--\r\n")
        return body
    }

    /// Whisper endpoints route on the filename extension, so it has to match the data.
    static func filename(for mimeType: String) -> String {
        switch mimeType.lowercased() {
        case "audio/m4a", "audio/x-m4a", "audio/mp4": return "audio.m4a"
        case "audio/mpeg", "audio/mp3": return "audio.mp3"
        case "audio/wav", "audio/x-wav": return "audio.wav"
        case "audio/webm": return "audio.webm"
        case "audio/ogg": return "audio.ogg"
        case "video/quicktime": return "capture.mov"
        case "video/mp4": return "capture.mp4"
        default: return "audio.m4a"
        }
    }

    static func parse(_ data: Data, model: String) throws -> Transcription {
        struct Payload: Decodable {
            var text: String?
            var language: String?
        }
        guard let payload = try? JSONDecoder().decode(Payload.self, from: data),
              let text = payload.text else {
            throw ExtractionError.malformedResponse("transcription response had no text")
        }
        return Transcription(
            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
            language: payload.language,
            model: model
        )
    }
}

/// A canned transcriber, for testing the pipeline without a network call.
public struct MockTranscriber: Transcriber {
    private let result: Result<Transcription, ExtractionError>

    public init(returning transcription: Transcription) { self.result = .success(transcription) }
    public init(failingWith error: ExtractionError) { self.result = .failure(error) }

    public func transcribe(_ media: CapturedMedia) async throws -> Transcription {
        guard media.containsAudio else {
            throw ExtractionError.emptyResult(reason: "recording contained no audio")
        }
        return try result.get()
    }
}
