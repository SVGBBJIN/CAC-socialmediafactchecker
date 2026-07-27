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
        /// Default is `nil`, meaning **the capture path is not registered at all**.
        /// That is deliberate: until the ReplayKit audio issue is resolved, shipping
        /// TikTok and Instagram would mean users sharing a link and getting silence
        /// back. A URL for an unregistered platform fails with a clear
        /// ``ExtractionError/unsupportedPlatform``, which the UI can turn into "not
        /// supported yet" — an honest answer rather than a broken feature.
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

        // Capture side of the fork. Registered only when there is something to record with.
        if let captureSource = configuration.captureSource {
            let transcriber = GroqWhisperTranscriber(secrets: configuration.secrets)

            extractors.append(
                CaptureBasedExtractor.tikTok(
                    captureSource: captureSource,
                    transcriber: transcriber,
                    captureDuration: configuration.captureDuration
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
        status[.tikTok] = configuration.captureSource == nil
            ? .unavailable("screen capture is unresolved — see docs/EXTRACTION_PIPELINE.md")
            : .supported
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
