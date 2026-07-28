import XCTest
@testable import SeerCore

final class OEmbedParsingTests: XCTestCase {
    /// Captured verbatim from `https://www.tiktok.com/oembed` on 2026-07-27. The
    /// endpoint is public and needed no credential.
    static let liveTikTokResponse = """
    {"version":"1.0","type":"video","title":"Scramble up ur name & I'll try to guess it",
    "author_url":"https://www.tiktok.com/@scout2015","author_name":"Scout, Suki & Stella",
    "width":"100%","height":"100%",
    "html":"<blockquote class=\\"tiktok-embed\\" cite=\\"https://www.tiktok.com/@scout2015/video/6718335390845095173\\" data-video-id=\\"6718335390845095173\\"> <section> </section> </blockquote> <script async src=\\"https://www.tiktok.com/embed.js\\"></script>",
    "thumbnail_url":"https://p16.muscdn.com/thumb.jpeg","thumbnail_width":720,"thumbnail_height":1280,
    "provider_url":"https://www.tiktok.com","provider_name":"TikTok"}
    """

    func testParsesLiveTikTokResponse() throws {
        let embed = try OEmbedResolver.parse(
            Data(Self.liveTikTokResponse.utf8),
            sourceURL: URL(string: "https://www.tiktok.com/@scout2015/video/6718335390845095173")!,
            platform: .tikTok
        )
        XCTAssertEqual(embed.authorName, "Scout, Suki & Stella")
        XCTAssertTrue(embed.html.contains("tiktok-embed"))
        XCTAssertTrue(embed.html.contains("embed.js"))
        XCTAssertNotNil(embed.thumbnailURL)
        // The thing that matters: oEmbed gives metadata and markup, never a transcript.
        // That absence is the entire reason the capture path exists.
        XCTAssertNil(embed.duration)
    }

    func testRejectsResponseWithoutEmbedHTML() {
        let json = #"{"version":"1.0","title":"no html here"}"#
        XCTAssertThrowsError(
            try OEmbedResolver.parse(
                Data(json.utf8), sourceURL: URL(string: "https://x.com")!, platform: .tikTok
            )
        )
    }

    func testStandaloneDocumentWrapsTheFragment() throws {
        let embed = try OEmbedResolver.parse(
            Data(Self.liveTikTokResponse.utf8),
            sourceURL: URL(string: "https://www.tiktok.com/@scout2015/video/6718335390845095173")!,
            platform: .tikTok
        )
        let document = embed.standaloneDocument()
        XCTAssertTrue(document.hasPrefix("<!DOCTYPE html>"))
        XCTAssertTrue(document.contains("tiktok-embed"))
        XCTAssertTrue(document.contains("viewport"))
    }

    func testInstagramResolverCarriesTheAccessToken() async {
        // Instagram's endpoint rejects unauthenticated calls; the token has to be on
        // the query string. Assert it's actually attached.
        let transport = StubTransport([.error(400, message: "checked the request only")])
        let resolver = OEmbedResolver.instagram(
            accessToken: "token-123", transport: transport, sleeper: ImmediateSleeper()
        )
        _ = try? await resolver.resolve(URL(string: "https://www.instagram.com/reel/ABC/")!)

        let requests = await transport.requests
        let url = requests.first?.url?.absoluteString ?? ""
        XCTAssertTrue(url.contains("graph.facebook.com"))
        XCTAssertTrue(url.contains("access_token=token-123"))
    }
}

final class CaptureBasedExtractorTests: XCTestCase {
    private struct StubResolver: EmbedResolver {
        var platform: Platform = .tikTok
        var authorName: String? = "Some Creator"
        func resolve(_ url: URL) async throws -> EmbeddedMedia {
            EmbeddedMedia(
                sourceURL: url,
                platform: platform,
                html: "<blockquote class=\"tiktok-embed\"></blockquote>",
                authorName: authorName,
                title: "A clip"
            )
        }
    }

    private struct FailingResolver: EmbedResolver {
        func resolve(_ url: URL) async throws -> EmbeddedMedia {
            throw ExtractionError.upstreamFailure(service: "oEmbed", status: 404, message: "gone")
        }
    }

    /// The whole point of the mock seam: this is the full TikTok pipeline, tested and
    /// working, with no dependency on the unresolved ReplayKit audio problem.
    func testFullCapturePipelineWithMockedRecorder() async throws {
        let extractor = CaptureBasedExtractor.tikTok(
            captureSource: MockCaptureSource.speaking(duration: 22),
            transcriber: MockTranscriber(
                returning: Transcription(text: "vaccines cause autism", language: "en", model: "whisper-large-v3-turbo")
            ),
            resolver: StubResolver()
        )

        let url = URL(string: "https://www.tiktok.com/@user/video/123")!
        let context = try await extractor.extract(from: url)

        // Identical shape to the YouTube path — that is the contract.
        XCTAssertEqual(context.transcript, "vaccines cause autism")
        XCTAssertEqual(context.provenance.platform, .tikTok)
        XCTAssertEqual(context.provenance.strategy, .screenCapture)
        XCTAssertEqual(context.provenance.authorName, "Some Creator")
        XCTAssertEqual(context.provenance.duration, 22)
        XCTAssertEqual(context.provenance.extra["transcriptionModel"], "whisper-large-v3-turbo")
        XCTAssertEqual(context.provenance.extra["language"], "en")
    }

    /// The known blocker, reproduced. A silent capture must fail loudly — an empty
    /// transcript reads downstream as "this video makes no claims", which is the worst
    /// possible outcome for a fact-checker.
    func testSilentCaptureFailsInsteadOfProducingAnEmptyTranscript() async {
        let extractor = CaptureBasedExtractor.tikTok(
            captureSource: MockCaptureSource.silent(),
            transcriber: MockTranscriber(returning: Transcription(text: "should never be reached")),
            resolver: StubResolver()
        )

        do {
            _ = try await extractor.extract(from: URL(string: "https://www.tiktok.com/@u/video/1")!)
            XCTFail("expected a silent capture to fail")
        } catch let error as ExtractionError {
            guard case .emptyResult(let reason) = error else {
                return XCTFail("expected emptyResult, got \(error)")
            }
            XCTAssertTrue(reason.lowercased().contains("audio"))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    /// Belt and braces: even if the extractor's guard were removed, the transcriber
    /// refuses to spend an API call on silence.
    func testTranscriberAlsoRefusesSilentMedia() async {
        let silent = CapturedMedia(
            data: Data(repeating: 0, count: 512), mimeType: "audio/m4a",
            duration: 10, containsAudio: false
        )
        do {
            _ = try await MockTranscriber(returning: Transcription(text: "x")).transcribe(silent)
            XCTFail("expected refusal")
        } catch let error as ExtractionError {
            guard case .emptyResult = error else { return XCTFail("got \(error)") }
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testEmbedFailurePropagates() async {
        let extractor = CaptureBasedExtractor.tikTok(
            captureSource: MockCaptureSource.speaking(),
            transcriber: MockTranscriber(returning: Transcription(text: "x")),
            resolver: FailingResolver()
        )
        do {
            _ = try await extractor.extract(from: URL(string: "https://www.tiktok.com/@u/video/1")!)
            XCTFail("expected failure")
        } catch let error as ExtractionError {
            guard case .upstreamFailure(_, let status, _) = error else {
                return XCTFail("got \(error)")
            }
            XCTAssertEqual(status, 404)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    /// Instagram reuses the identical pipeline — only the resolver differs. If this
    /// ever needs its own extractor, the abstraction has failed.
    func testInstagramReusesTheSamePipeline() async throws {
        let extractor = CaptureBasedExtractor.instagram(
            accessToken: "token",
            captureSource: MockCaptureSource.speaking(),
            transcriber: MockTranscriber(returning: Transcription(text: "instagram audio")),
            resolver: StubResolver(platform: .instagram, authorName: "IG Creator")
        )
        let context = try await extractor.extract(
            from: URL(string: "https://www.instagram.com/reel/ABCDEFGHIJK/")!
        )
        XCTAssertEqual(context.transcript, "instagram audio")
        XCTAssertEqual(context.provenance.platform, .instagram)
        XCTAssertEqual(context.provenance.strategy, .screenCapture)
    }
}

final class WhisperRequestTests: XCTestCase {
    func testMultipartBodyCarriesFileAndFields() {
        let media = CapturedMedia(
            data: Data("AUDIOBYTES".utf8), mimeType: "audio/m4a", duration: 10, containsAudio: true
        )
        let body = GroqWhisperTranscriber.multipartBody(
            boundary: "BOUNDARY", media: media, fields: ["model": "whisper-large-v3-turbo"]
        )
        let text = String(data: body, encoding: .utf8)!

        XCTAssertTrue(text.contains("--BOUNDARY"))
        XCTAssertTrue(text.contains("name=\"model\""))
        XCTAssertTrue(text.contains("whisper-large-v3-turbo"))
        XCTAssertTrue(text.contains("filename=\"audio.m4a\""))
        XCTAssertTrue(text.contains("AUDIOBYTES"))
        XCTAssertTrue(text.hasSuffix("--BOUNDARY--\r\n"))
    }

    /// Whisper endpoints route on the filename extension, so it must track the MIME type.
    func testFilenameMatchesMimeType() {
        XCTAssertEqual(GroqWhisperTranscriber.filename(for: "audio/m4a"), "audio.m4a")
        XCTAssertEqual(GroqWhisperTranscriber.filename(for: "audio/mpeg"), "audio.mp3")
        XCTAssertEqual(GroqWhisperTranscriber.filename(for: "video/quicktime"), "capture.mov")
        XCTAssertEqual(GroqWhisperTranscriber.filename(for: "something/unknown"), "audio.m4a")
    }

    func testParsesTranscriptionResponse() throws {
        let json = #"{"text":"  hello world  ","language":"english"}"#
        let transcription = try GroqWhisperTranscriber.parse(Data(json.utf8), model: "whisper-large-v3-turbo")
        XCTAssertEqual(transcription.text, "hello world")
        XCTAssertEqual(transcription.language, "english")
    }

    func testSilentMediaIsNeverUploaded() async {
        let transport = StubTransport([.ok(#"{"text":"hallucinated"}"#)])
        let transcriber = GroqWhisperTranscriber(
            transport: transport,
            secrets: InMemorySecretStore([.groqAPIKey: "k"]),
            sleeper: ImmediateSleeper()
        )
        let silent = CapturedMedia(
            data: Data(repeating: 0, count: 4096), mimeType: "audio/m4a",
            duration: 12, containsAudio: false
        )
        _ = try? await transcriber.transcribe(silent)

        let count = await transport.requestCount
        XCTAssertEqual(count, 0, "silent audio must not be sent to the transcription API")
    }
}

final class PipelineBuilderTests: XCTestCase {
    /// TikTok needs no recorder — it fetches the media directly — but Instagram still
    /// does, and must stay unregistered until there is one. A user sharing an Instagram
    /// link gets a clear "not supported yet" rather than silence.
    func testOnlyInstagramWaitsOnARecorder() async {
        let pipeline = SeerPipelineBuilder.makePipeline(
            .init(secrets: InMemorySecretStore([.geminiAPIKey: "k"]))
        )
        XCTAssertNotNil(pipeline.extractor(for: URL(string: "https://youtu.be/jNQXAC9IVRw")!))
        XCTAssertNotNil(pipeline.extractor(for: URL(string: "https://www.tiktok.com/@u/video/1")!))
        XCTAssertNil(pipeline.extractor(for: URL(string: "https://www.instagram.com/reel/ABC/")!))
    }

    /// The registered TikTok extractor is the direct-fetch one, not a capture extractor
    /// that happens to answer for the same platform.
    func testTikTokRegistersOnTheDirectFetchPath() {
        let pipeline = SeerPipelineBuilder.makePipeline(
            .init(secrets: InMemorySecretStore([.geminiAPIKey: "k"]))
        )
        let extractor = pipeline.extractor(for: URL(string: "https://www.tiktok.com/@u/video/1")!)
        XCTAssertEqual(extractor?.strategy, .directMediaFetch)
        XCTAssertTrue(extractor is DirectMediaExtractor)
    }

    func testCapturePlatformsRegisterOnceASourceExists() {
        let pipeline = SeerPipelineBuilder.makePipeline(
            .init(
                secrets: InMemorySecretStore([.geminiAPIKey: "k", .groqAPIKey: "g"]),
                captureSource: MockCaptureSource.speaking(),
                instagramAccessToken: "meta-token"
            )
        )
        XCTAssertNotNil(pipeline.extractor(for: URL(string: "https://www.tiktok.com/@u/video/1")!))
        XCTAssertNotNil(pipeline.extractor(for: URL(string: "https://www.instagram.com/reel/ABC/")!))
    }

    /// Instagram needs a Meta token even when capture works.
    func testInstagramStaysUnregisteredWithoutAMetaToken() {
        let pipeline = SeerPipelineBuilder.makePipeline(
            .init(
                secrets: InMemorySecretStore([.geminiAPIKey: "k", .groqAPIKey: "g"]),
                captureSource: MockCaptureSource.speaking()
            )
        )
        XCTAssertNotNil(pipeline.extractor(for: URL(string: "https://www.tiktok.com/@u/video/1")!))
        XCTAssertNil(pipeline.extractor(for: URL(string: "https://www.instagram.com/reel/ABC/")!))
    }

    func testSupportStatusExplainsEachGap() {
        let status = SeerPipelineBuilder.supportStatus(
            .init(secrets: InMemorySecretStore([.geminiAPIKey: "k"]))
        )
        XCTAssertEqual(status[.youTube], .supported)
        // TikTok needs only the Gemini key now, which this configuration has.
        XCTAssertEqual(status[.tikTok], .supported)
        guard case .unavailable(let instagramReason)? = status[.instagram] else {
            return XCTFail("expected Instagram unavailable")
        }
        XCTAssertTrue(instagramReason.contains("capture"))
    }
}
