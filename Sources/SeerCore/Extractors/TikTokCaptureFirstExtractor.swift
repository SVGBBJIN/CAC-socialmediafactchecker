import Foundation

/// TikTok, capture-first: try ``CaptureBasedExtractor`` (WKWebView + `RPScreenRecorder`
/// + Whisper), and fall back to ``DirectMediaExtractor`` (embed → CDN MP4 → Gemini) if
/// the capture attempt fails for any reason — most notably the known ReplayKit/WKWebView
/// silent-audio defect.
///
/// This inverts the arrangement described in docs/EXTRACTION_PIPELINE.md, where TikTok
/// moved *off* the capture path entirely because the audio issue was unresolved and the
/// direct-fetch path is strictly cheaper. Both extractors still exist and both still
/// work; this type only changes which one a TikTok URL tries first, and guarantees a
/// working result either way rather than a silent empty transcript.
///
/// Which arm actually served a given request is never ambiguous after the fact:
/// `provenance.strategy` says which extractor's `ClaimContext` this is, and
/// `provenance.extra["servedBy"]` says the same in a fixed string, plus
/// `capturePathFailure` carrying the reason whenever the fallback fired. Nothing here
/// retries silently — a caller inspecting one `ClaimContext` can always tell which path
/// ran and, when capture failed, why.
public struct TikTokCaptureFirstExtractor: ClaimExtractor {
    public let platform: Platform = .tikTok
    private let captureExtractor: CaptureBasedExtractor
    private let fallbackExtractor: DirectMediaExtractor

    public init(captureExtractor: CaptureBasedExtractor, fallbackExtractor: DirectMediaExtractor) {
        precondition(
            captureExtractor.platform == .tikTok && fallbackExtractor.platform == .tikTok,
            "TikTokCaptureFirstExtractor requires both arms to be configured for .tikTok"
        )
        self.captureExtractor = captureExtractor
        self.fallbackExtractor = fallbackExtractor
    }

    public func canHandle(_ url: URL) -> Bool {
        // Matches DirectMediaExtractor's dispatch, not the stricter
        // CaptureBasedExtractor.canHandle (which also demands a single-post path):
        // a URL that isn't a single post should still reach `extract()` and fail there
        // with `notAMediaURL`, the same as it always has, rather than being rejected
        // one layer up as `unsupportedPlatform` because the capture arm alone declined it.
        Platform.detect(from: url) == platform
    }

    public func extract(from url: URL, progress: ProgressSink) async throws -> ClaimContext {
        // A profile, tag or carousel link matches `canHandle` (host-only, like
        // DirectMediaExtractor's) but names no single video. Decline it here, before
        // spending an oEmbed round trip on the capture arm and a CDN resolve on the
        // fallback, with the same clean `notAMediaURL` either path would eventually
        // reach on its own — rather than two wasted attempts collapsing into an opaque
        // `allCandidatesFailed`.
        guard CaptureBasedExtractor.identifiesSinglePost(url, on: platform) else {
            throw ExtractionError.notAMediaURL(url)
        }

        do {
            var context = try await captureExtractor.extract(from: url, progress: progress)
            context.provenance.extra["servedBy"] = "screenCapture"
            return context
        } catch is CancellationError {
            // The caller gave up; falling back would start a second, unwanted attempt.
            throw CancellationError()
        } catch {
            let captureFailure = "\(error)"
            progress.send(
                .resolving,
                detail: "capture path failed, falling back to direct media fetch: \(captureFailure)"
            )
            do {
                var context = try await fallbackExtractor.extract(from: url, progress: progress)
                context.provenance.extra["servedBy"] = "directMediaFetch"
                context.provenance.extra["capturePathFailure"] = captureFailure
                return context
            } catch {
                throw ExtractionError.allCandidatesFailed(attempts: [
                    "screenCapture: \(captureFailure)",
                    "directMediaFetch: \(error)",
                ])
            }
        }
    }
}
