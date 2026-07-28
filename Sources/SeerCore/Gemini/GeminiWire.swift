import Foundation

// Wire types for `generativelanguage.googleapis.com/v1beta`.
//
// Hand-written rather than generated: we touch a very small corner of the API, and
// the decoders below are deliberately lenient about fields we don't consume, so a
// server-side addition can't break parsing.

struct GeminiRequest: Encodable {
    var contents: [Content]
    var generationConfig: GenerationConfig?

    struct Content: Encodable {
        var parts: [Part]
    }

    /// A request part. Exactly one of the payload fields is set.
    struct Part: Encodable {
        var text: String?
        var fileData: FileData?
        var inlineData: InlineData?
        /// Only meaningful alongside `fileData` for a video.
        var videoMetadata: VideoMetadata?

        enum CodingKeys: String, CodingKey {
            case text
            case fileData = "file_data"
            case inlineData = "inline_data"
            case videoMetadata = "video_metadata"
        }

        static func text(_ value: String) -> Part { Part(text: value) }

        /// A URL the model fetches itself. For YouTube this is the whole trick: no
        /// download, no frame extraction, no upload.
        static func youTubeURL(_ url: URL, clip: VideoMetadata? = nil) -> Part {
            Part(fileData: FileData(fileUri: url.absoluteString), videoMetadata: clip)
        }

        static func inline(_ data: Data, mimeType: String) -> Part {
            Part(inlineData: InlineData(mimeType: mimeType, data: data.base64EncodedString()))
        }

        /// A file already uploaded through the Files API. Same `file_data` shape as a
        /// YouTube URL, but the URI points at Google's own storage.
        static func file(uri: String, mimeType: String) -> Part {
            Part(fileData: FileData(mimeType: mimeType, fileUri: uri))
        }
    }

    struct FileData: Encodable {
        var mimeType: String?
        var fileUri: String
        enum CodingKeys: String, CodingKey {
            case mimeType = "mime_type"
            case fileUri = "file_uri"
        }
    }

    struct InlineData: Encodable {
        var mimeType: String
        /// base64
        var data: String
        enum CodingKeys: String, CodingKey {
            case mimeType = "mime_type"
            case data
        }
    }

    /// Restricts processing to a slice of the video. Offsets are strings with a
    /// trailing `s`, e.g. `"90s"`.
    struct VideoMetadata: Encodable {
        var startOffset: String?
        var endOffset: String?
        enum CodingKeys: String, CodingKey {
            case startOffset = "start_offset"
            case endOffset = "end_offset"
        }

        init(start: TimeInterval? = nil, end: TimeInterval? = nil) {
            self.startOffset = start.map { "\(Int($0))s" }
            self.endOffset = end.map { "\(Int($0))s" }
        }
    }

    struct GenerationConfig: Encodable {
        var responseMimeType: String?
        var temperature: Double?
        var maxOutputTokens: Int?

        enum CodingKeys: String, CodingKey {
            case responseMimeType = "response_mime_type"
            case temperature
            case maxOutputTokens = "max_output_tokens"
        }
    }
}

struct GeminiResponse: Decodable {
    var candidates: [Candidate]?
    var promptFeedback: PromptFeedback?
    var usageMetadata: UsageMetadata?
    var modelVersion: String?

    struct Candidate: Decodable {
        var content: Content?
        var finishReason: String?
    }

    struct Content: Decodable {
        var parts: [Part]?
    }

    /// Parts may carry fields other than `text` — reasoning models return a
    /// `thoughtSignature`, and some parts carry no text at all. Only `text` is decoded;
    /// everything else is ignored rather than treated as a parse failure.
    struct Part: Decodable {
        var text: String?
    }

    struct PromptFeedback: Decodable {
        var blockReason: String?
    }

    struct UsageMetadata: Decodable {
        var promptTokenCount: Int?
        var candidatesTokenCount: Int?
        var totalTokenCount: Int?
    }

    /// All text parts of the first candidate, concatenated.
    var text: String? {
        guard let parts = candidates?.first?.content?.parts else { return nil }
        let joined = parts.compactMap(\.text).joined()
        return joined.isEmpty ? nil : joined
    }

    var finishReason: String? { candidates?.first?.finishReason }
}

/// The JSON we ask the model to return. Field names match the prompt in
/// ``GeminiVideoClient/transcriptionPrompt``.
struct GeminiVideoAnalysis: Decodable {
    var transcript: String?
    var onScreenText: String?
    var title: String?
    var claims: [Claim]?

    struct Claim: Decodable {
        var text: String?
        var timestampSeconds: Double?
        var quote: String?
    }

    /// Models occasionally wrap JSON in a ```json fence despite `responseMimeType`.
    /// Strip it rather than failing the whole extraction over punctuation.
    ///
    /// - Parameter mayBeTruncated: set when the model reported `MAX_TOKENS`. Output cut
    ///   off mid-write is *never* valid JSON, so without a salvage step a long video
    ///   fails outright and a nearly complete transcript is thrown away — see
    ///   ``salvageTranscript(from:)``.
    static func decode(from raw: String, mayBeTruncated: Bool = false) throws -> GeminiVideoAnalysis {
        let cleaned = stripCodeFence(raw)
        guard let data = cleaned.data(using: .utf8) else {
            throw ExtractionError.malformedResponse("model output was not UTF-8")
        }
        do {
            return try JSONDecoder().decode(GeminiVideoAnalysis.self, from: data)
        } catch {
            if mayBeTruncated, let salvaged = salvageTranscript(from: cleaned) {
                return salvaged
            }
            throw ExtractionError.malformedResponse(
                "model output was not the expected JSON: \(cleaned.prefix(200))"
            )
        }
    }

    /// Recovers the transcript from JSON the model didn't finish writing.
    ///
    /// Only the transcript. `claims` is deliberately dropped rather than partially
    /// parsed: a claim cut off halfway reads as a *different, shorter* assertion than
    /// the one that was made, and this pipeline feeds a fact-checker that would then
    /// check and report it against the speaker. A missing hint costs nothing — the
    /// fact-check layer does its own claim detection — while a mangled one is a
    /// fabricated quote.
    static func salvageTranscript(from raw: String) -> GeminiVideoAnalysis? {
        guard let transcript = jsonStringValue(forKey: "transcript", in: raw),
              !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return GeminiVideoAnalysis(
            transcript: transcript, onScreenText: nil, title: nil, claims: []
        )
    }

    /// Reads the string value of `key` out of possibly-incomplete JSON.
    ///
    /// Hand-rolled because every real JSON parser refuses the input by definition: the
    /// document is unterminated. Handles the escape sequences JSON defines, and stops at
    /// the closing quote or at the end of the text, whichever comes first.
    static func jsonStringValue(forKey key: String, in raw: String) -> String? {
        guard let keyRange = raw.range(of: "\"\(key)\"") else { return nil }

        var index = keyRange.upperBound
        func skipWhitespace() {
            while index < raw.endIndex, raw[index].isWhitespace { index = raw.index(after: index) }
        }

        skipWhitespace()
        guard index < raw.endIndex, raw[index] == ":" else { return nil }
        index = raw.index(after: index)
        skipWhitespace()
        guard index < raw.endIndex, raw[index] == "\"" else { return nil }
        index = raw.index(after: index)

        var value = ""
        while index < raw.endIndex {
            let character = raw[index]

            guard character == "\\" else {
                if character == "\"" { break }  // Properly terminated.
                value.append(character)
                index = raw.index(after: index)
                continue
            }

            let escapeIndex = raw.index(after: index)
            guard escapeIndex < raw.endIndex else { break }  // Truncated mid-escape.

            switch raw[escapeIndex] {
            case "n": value.append("\n")
            case "t": value.append("\t")
            case "r": value.append("\r")
            case "b": value.append("\u{08}")
            case "f": value.append("\u{0C}")
            case "u":
                // \uXXXX. A lone surrogate half — which is what a cut-off pair leaves —
                // has no scalar, so stop and keep what was read rather than guessing.
                let hexStart = raw.index(after: escapeIndex)
                guard let hexEnd = raw.index(hexStart, offsetBy: 4, limitedBy: raw.endIndex),
                      let code = UInt32(raw[hexStart..<hexEnd], radix: 16),
                      let scalar = Unicode.Scalar(code) else {
                    return value
                }
                value.unicodeScalars.append(scalar)
                index = hexEnd
                continue
            default:
                // Covers `\"`, `\\` and `\/`, and passes anything else through as itself.
                value.append(raw[escapeIndex])
            }
            index = raw.index(after: escapeIndex)
        }

        return value
    }

    static func stripCodeFence(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("```") else { return text }
        if let firstNewline = text.firstIndex(of: "\n") {
            text = String(text[text.index(after: firstNewline)...])
        }
        if let fenceRange = text.range(of: "```", options: .backwards) {
            text = String(text[..<fenceRange.lowerBound])
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
