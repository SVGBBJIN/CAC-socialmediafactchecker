import Foundation

/// A Gemini model the video path may use.
///
/// Model IDs verified against `GET /v1beta/models` on 2026-07-27; every ID below was
/// present and advertised `generateContent`.
public struct GeminiModel: RawRepresentable, Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { self.rawValue = value }
    public var description: String { rawValue }

    public static let flash3_6: GeminiModel = "gemini-3.6-flash"
    public static let flash3_5: GeminiModel = "gemini-3.5-flash"
    /// 3-series Flash only ships under the preview ID; there is no `gemini-3-flash`.
    public static let flash3: GeminiModel = "gemini-3-flash-preview"
    public static let flash2_5: GeminiModel = "gemini-2.5-flash"
    /// The 2-series ID is `2.0`, not `2`.
    public static let flash2: GeminiModel = "gemini-2.0-flash"
}

/// An ordered list of models to try.
///
/// The chain exists because model availability is not a constant: preview IDs get
/// retired, and a key's tier may not be granted access to the newest model. Rather
/// than pin one ID and break in the field, the client walks the chain and uses the
/// first model that answers.
///
/// Falling through is driven by *availability* errors only (404/403 and the like).
/// A malformed request or a content-policy refusal fails outright — retrying those on
/// an older model would just spend money to get the same answer more slowly.
public struct GeminiModelChain: Sendable, Equatable {
    public let models: [GeminiModel]

    public init(_ models: [GeminiModel]) {
        precondition(!models.isEmpty, "a model chain needs at least one model")
        self.models = models
    }

    /// Flash 3.6 preferred, then 3.5, 3, 2.5, 2 — the order specified for this project.
    public static let flashPreferred = GeminiModelChain([
        .flash3_6,
        .flash3_5,
        .flash3,
        .flash2_5,
        .flash2,
    ])
}

/// Whether a failure against one model means "try the next one".
///
/// - 404: no such model for this API version. Fall through.
/// - 403: key isn't entitled to this model. Fall through.
/// - 400 mentioning the model or an unsupported part: usually a newer/older model that
///   doesn't accept a YouTube file part. Fall through — this is the case that bites
///   when a preview ID changes its input contract.
/// - Everything else (429, 5xx, policy refusals) is handled by the retry layer or is
///   terminal; falling through would not help.
func shouldFallThrough(to nextModel: Bool = true, on error: Error) -> Bool {
    guard case let ExtractionError.upstreamFailure(_, status, message) = error else { return false }
    switch status {
    case 404, 403:
        return true
    case 400:
        let lowered = message.lowercased()
        return lowered.contains("not found")
            || lowered.contains("not supported")
            || lowered.contains("unsupported")
            || lowered.contains("invalid model")
    default:
        return false
    }
}
