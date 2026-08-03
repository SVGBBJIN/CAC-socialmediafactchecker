import Foundation

/// Assembles the pipeline the share extension uses.
///
/// One place where credentials, transports and the capture source get wired together,
/// so swapping the mock recorder for the real one — or moving to a backend proxy — is
/// a change here and nowhere else.
public enum SeerPipelineBuilder {
    /// What the app can currently do.
    public struct Configuration: Sendable {
        /// Credential source. On device: Keychain → encrypted bundle → environment.
        public var secrets: any SecretStore
        /// Where recordings come from.
        ///
        /// Default is `nil`, meaning **no platform gets a capture attempt**. Instagram
        /// still has no other option, so without this it isn't registered at all — a
        /// URL for it fails with a clear ``ExtractionError/unsupportedPlatform``, which
        /// the UI can turn into "not supported yet" rather than a broken feature.
        ///
        /// TikTok is different: it is registered either way. With a capture source, it
        /// runs through ``TikTokCaptureFirstExtractor`` — capture first, direct CDN
        /// fetch as the automatic fallback when capture fails (notably the known
        /// ReplayKit/WKWebView silent-audio defect, see
        /// docs/EXTRACTION_PIPELINE.md). Without one, it registers the direct-fetch
        /// extractor alone, since there's nothing to record with.
        public var captureSource: (any MediaCaptureSource)?
        /// Meta app token. Without one, Instagram cannot be registered — its oEmbed
        /// endpoint requires it. See docs/SPIKE-instagram.md.
        public var instagramAccessToken: String?
        public var modelChain: GeminiModelChain
        /// Cap on how much of a long video to analyse, in seconds.
        public var maxAnalysedDuration: TimeInterval?
        public var captureDuration: TimeInterval

        public init(
            secrets: any SecretStore,
            captureSource: (any MediaCaptureSource)? = nil,
            instagramAccessToken: String? = nil,
            modelChain: GeminiModelChain = .flashPreferred,
            maxAnalysedDuration: TimeInterval? = 1800,
            captureDuration: TimeInterval = 60
        ) {
            self.secrets = secrets
            self.captureSource = captureSource
            self.instagramAccessToken = instagramAccessToken
            self.modelChain = modelChain
            self.maxAnalysedDuration = maxAnalysedDuration
            self.captureDuration = captureDuration
        }
    }

    /// Builds the pipeline, registering only the platforms the configuration can
    /// actually serve.
    public static func makePipeline(_ configuration: Configuration) -> ExtractionPipeline {
        var extractors: [any ClaimExtractor] = []

        // Native-ingestion side of the fork. Needs nothing but a key.
        let gemini = GeminiVideoClient(
            transport: URLSessionTransport.videoUnderstanding(),
            secrets: configuration.secrets,
            chain: configuration.modelChain
        )
        extractors.append(
            YouTubeExtractor(client: gemini, maxDuration: configuration.maxAnalysedDuration)
        )

        // TikTok. Exactly one extractor gets registered for it — never both, since the
        // pipeline dispatches on the first match and a second registration would just
        // be dead code.
        let tikTokFallback = DirectMediaExtractor.tikTok(
            client: gemini,
            filesClient: GeminiFilesClient(secrets: configuration.secrets)
        )

        if let captureSource = configuration.captureSource {
            let transcriber = GroqWhisperTranscriber(secrets: configuration.secrets)

            // Capture-first, with the direct CDN fetch above wired in as the automatic
            // fallback. See TikTokCaptureFirstExtractor.
            extractors.append(
                TikTokCaptureFirstExtractor(
                    captureExtractor: .tikTok(
                        captureSource: captureSource,
                        transcriber: transcriber,
                        captureDuration: configuration.captureDuration
                    ),
                    fallbackExtractor: tikTokFallback
                )
            )

            if let token = configuration.instagramAccessToken, !token.isEmpty {
                extractors.append(
                    CaptureBasedExtractor.instagram(
                        accessToken: token,
                        captureSource: captureSource,
                        transcriber: transcriber,
                        captureDuration: configuration.captureDuration
                    )
                )
            }
        } else {
            // No capture source: nothing to record with, so direct-fetch runs alone.
            extractors.append(tikTokFallback)
        }

        return ExtractionPipeline(extractors: extractors)
    }

    /// Which platforms a configuration can serve, and why the others can't.
    ///
    /// Lets the UI say "Instagram isn't supported yet" up front, rather than after the
    /// user has waited through a share sheet.
    public static func supportStatus(_ configuration: Configuration) -> [Platform: SupportStatus] {
        var status: [Platform: SupportStatus] = [:]
        status[.youTube] = .supported
        // Not conditional on a capture source: with one, TikTok runs capture-first with
        // direct-fetch as fallback; without one, direct-fetch alone. Either way the
        // Gemini key `Configuration` already requires is enough to serve it.
        status[.tikTok] = .supported
        status[.instagram] = {
            if configuration.captureSource == nil {
                return .unavailable("screen capture is unresolved — see docs/EXTRACTION_PIPELINE.md")
            }
            if configuration.instagramAccessToken?.isEmpty != false {
                return .unavailable("needs a Meta app token with oembed_read — see docs/SPIKE-instagram.md")
            }
            return .supported
        }()
        return status
    }

    public enum SupportStatus: Sendable, Equatable {
        case supported
        case unavailable(String)
    }
}
