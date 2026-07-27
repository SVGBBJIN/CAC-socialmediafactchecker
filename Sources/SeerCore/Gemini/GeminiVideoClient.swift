import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Calls Gemini's `generateContent` with a video, walking the model fallback chain.
public struct GeminiVideoClient: Sendable {
    private let transport: any HTTPTransport
    private let secrets: any SecretStore
    private let chain: GeminiModelChain
    private let policy: RetryPolicy
    private let sleeper: any Sleeper
    private let baseURL: URL

    public init(
        transport: any HTTPTransport = URLSessionTransport.videoUnderstanding(),
        secrets: any SecretStore,
        chain: GeminiModelChain = .flashPreferred,
        policy: RetryPolicy = .videoUnderstanding,
        sleeper: any Sleeper = TaskSleeper(),
        baseURL: URL = URL(string: "https://generativelanguage.googleapis.com/v1beta")!
    ) {
        self.transport = transport
        self.secrets = secrets
        self.chain = chain
        self.policy = policy
        self.sleeper = sleeper
        self.baseURL = baseURL
    }

    /// Result of one successful call, with the model that produced it.
    public struct Result: Sendable {
        public var analysis: GeminiVideoAnalysisPublic
        public var model: GeminiModel
    }

    /// Analyse a video that Gemini can fetch itself, given only its URL.
    public func analyzeVideo(at url: URL, clip: GeminiClip? = nil) async throws -> Result {
        let request = GeminiRequest(
            contents: [
                .init(parts: [
                    .youTubeURL(url, clip: clip.map { .init(start: $0.start, end: $0.end) }),
                    .text(Self.transcriptionPrompt),
                ])
            ],
            generationConfig: .init(responseMimeType: "application/json", temperature: 0)
        )
        return try await send(request)
    }

    /// Analyse media we already hold as bytes. Used by the capture path when the audio
    /// is small enough to send inline, and by tests.
    public func analyzeInlineMedia(_ data: Data, mimeType: String) async throws -> Result {
        let request = GeminiRequest(
            contents: [
                .init(parts: [
                    .inline(data, mimeType: mimeType),
                    .text(Self.transcriptionPrompt),
                ])
            ],
            generationConfig: .init(responseMimeType: "application/json", temperature: 0)
        )
        return try await send(request)
    }

    // MARK: - Chain walk

    private func send(_ body: GeminiRequest) async throws -> Result {
        let apiKey = try secrets.requireSecret(named: .geminiAPIKey)
        let payload = try JSONEncoder().encode(body)

        var attempted: [String] = []
        var lastError: Error?

        for model in chain.models {
            try Task.checkCancellation()
            do {
                let data = try await call(model: model, apiKey: apiKey, payload: payload)
                let analysis = try Self.parse(data)
                return Result(analysis: analysis, model: model)
            } catch {
                attempted.append("\(model): \(Self.describe(error))")
                lastError = error
                guard shouldFallThrough(on: error) else { throw error }
                // Otherwise: this model is unavailable to us. Try the next one.
                continue
            }
        }

        if let lastError, chain.models.count == 1 { throw lastError }
        throw ExtractionError.allCandidatesFailed(attempts: attempted)
    }

    private func call(model: GeminiModel, apiKey: String, payload: Data) async throws -> Data {
        let url = baseURL.appendingPathComponent("models/\(model.rawValue):generateContent")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = payload
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Header rather than a `?key=` query parameter: query strings end up in proxy
        // logs, crash reports and `URLSession` metrics far more readily than headers do.
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")

        let client = RetryingHTTPClient(
            transport: transport, policy: policy, serviceName: "Gemini", sleeper: sleeper
        )
        return try await client.send(request)
    }

    static func parse(_ data: Data) throws -> GeminiVideoAnalysisPublic {
        let response: GeminiResponse
        do {
            response = try JSONDecoder().decode(GeminiResponse.self, from: data)
        } catch {
            throw ExtractionError.malformedResponse("could not decode Gemini envelope")
        }

        if let blockReason = response.promptFeedback?.blockReason {
            throw ExtractionError.emptyResult(reason: "Gemini blocked the request (\(blockReason))")
        }

        guard let text = response.text else {
            let reason = response.finishReason ?? "no candidates"
            throw ExtractionError.emptyResult(reason: "Gemini returned no text (\(reason))")
        }

        // MAX_TOKENS still leaves usable, if truncated, output — keep it rather than
        // discarding a mostly-complete transcript.
        let analysis = try GeminiVideoAnalysis.decode(from: text)
        return GeminiVideoAnalysisPublic(
            transcript: analysis.transcript ?? "",
            onScreenText: analysis.onScreenText?.isEmpty == true ? nil : analysis.onScreenText,
            title: analysis.title,
            claims: (analysis.claims ?? []).compactMap { claim in
                guard let text = claim.text, !text.isEmpty else { return nil }
                return CandidateClaim(
                    text: text, timestamp: claim.timestampSeconds, sourceQuote: claim.quote
                )
            },
            truncated: response.finishReason == "MAX_TOKENS"
        )
    }

    static func describe(_ error: Error) -> String {
        (error as? ExtractionError)?.errorDescription ?? "\(error)"
    }

    /// Asks for the shape ``GeminiVideoAnalysis`` decodes.
    ///
    /// Two deliberate instructions: transcribe *verbatim* (a summary is useless for
    /// fact-checking — the wording is the claim), and leave `claims` empty rather than
    /// inventing one, since a fabricated claim would be checked and reported as if the
    /// speaker had made it.
    static let transcriptionPrompt = """
    Analyse this video and return a single JSON object with these keys:

    - "transcript": the spoken audio, transcribed verbatim. Preserve the speaker's own \
    wording, including hedges and qualifiers. Do not summarise, correct, or paraphrase. \
    Use "" if there is no speech.
    - "onScreenText": text visible on screen (captions burned into the video, titles, \
    graphics), or null if there is none. Do not repeat the spoken transcript here.
    - "title": a short neutral description of the video, or null.
    - "claims": an array of the checkable factual assertions made in the video. Each \
    entry is an object with "text" (the claim stated plainly), "timestampSeconds" (a \
    number, or null) and "quote" (the verbatim span from the transcript that makes it). \
    Include only assertions actually made in the video. Opinions, jokes and predictions \
    are not claims. If there are none, return an empty array — never invent one.

    Return only the JSON object.
    """
}

/// Parsed analysis, in a shape callers outside the module can use.
public struct GeminiVideoAnalysisPublic: Sendable, Equatable {
    public var transcript: String
    public var onScreenText: String?
    public var title: String?
    public var claims: [CandidateClaim]
    /// The model hit its output cap; the transcript is cut short.
    public var truncated: Bool

    public init(
        transcript: String,
        onScreenText: String? = nil,
        title: String? = nil,
        claims: [CandidateClaim] = [],
        truncated: Bool = false
    ) {
        self.transcript = transcript
        self.onScreenText = onScreenText
        self.title = title
        self.claims = claims
        self.truncated = truncated
    }
}

/// A slice of a video to analyse, for clips too long to process whole.
public struct GeminiClip: Sendable, Equatable {
    public var start: TimeInterval?
    public var end: TimeInterval?
    public init(start: TimeInterval? = nil, end: TimeInterval? = nil) {
        self.start = start
        self.end = end
    }
}
