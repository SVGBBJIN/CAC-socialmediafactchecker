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
/// - 429, or anything else meaning "out of quota": fall through. This one only reaches
///   here *after* `HTTPTransport` has retried it with backoff and honoured any
///   `Retry-After`, so it is not a blip — it is a quota that is genuinely spent. Gemini
///   meters quota per model, so the next model in the chain has its own and frequently
///   answers. Treating it as terminal, as this did, meant the chain covered the rare
///   failure (a retired model ID) and not the common one.
/// - Everything else (5xx, policy refusals, a bad key) is terminal; falling through would
///   hammer an outage or re-spend a credential that cannot work.
func shouldFallThrough(on error: Error) -> Bool {
    guard case let ExtractionError.upstreamFailure(_, status, message) = error else { return false }
    // First, and unconditionally: a bad key arrives as a 400 or 403, both of which the
    // rules below would otherwise wave through.
    if isInvalidKeyFailure(status: status, message: message) { return false }
    if isQuotaFailure(status: status, message: message) { return true }
    switch status {
    case 404, 403:
        return true
    case 400:
        // The bad-key case a 400 can also carry is caught by the guard above, before
        // any of these run — otherwise the next model gets the same broken credential.
        let lowered = message.lowercased()
        return lowered.contains("not found")
            || lowered.contains("not supported")
            || lowered.contains("unsupported")
            || lowered.contains("invalid model")
    default:
        return false
    }
}

/// Whether a failure means "this model has no quota left right now".
///
/// 429 is the documented status but not the only carrier: a project whose generative
/// language quota is spent, or whose billing has lapsed, can answer 403 with
/// `RESOURCE_EXHAUSTED` in the body. What matters is not the status but whether another
/// model — with its own quota — would answer, and for all of these it would.
func isQuotaFailure(status: Int?, message: String) -> Bool {
    if status == 429 { return true }
    guard status == 400 || status == 403 else { return false }
    let lowered = message.lowercased()
    return lowered.contains("quota")
        || lowered.contains("rate limit")
        || lowered.contains("resource_exhausted")
        || lowered.contains("resource exhausted")
}

/// Whether a failure is really "that key is no good", whatever status it arrived under.
///
/// Gemini answers an invalid key with **HTTP 400 / `API_KEY_INVALID`**, not 401 —
/// verified against the live endpoint on 2026-07-27. Worth naming rather than leaving
/// implicit: the message is the only thing distinguishing it from an ordinary bad
/// request, and getting it wrong means walking the whole model chain with a credential
/// that cannot work.
func isInvalidKeyFailure(status: Int?, message: String) -> Bool {
    if status == 401 { return true }
    guard status == 400 || status == 403 else { return false }
    let lowered = message.lowercased()
    return lowered.contains("api key not valid")
        || lowered.contains("api key is invalid")
        || lowered.contains("invalid api key")
        || lowered.contains("api_key_invalid")
}
