import XCTest
@testable import SeerCore

final class GeminiResponseParsingTests: XCTestCase {
    /// Captured verbatim from a live `gemini-3.6-flash:generateContent` call against
    /// `https://www.youtube.com/watch?v=jNQXAC9IVRw` on 2026-07-27.
    ///
    /// Note the `thoughtSignature` sitting alongside `text` in the same part: reasoning
    /// models add fields the parser has never seen, and a strict decoder would have
    /// thrown on the real API's very first response.
    static let liveResponse = """
    {
      "candidates": [
        {
          "content": {
            "parts": [
              {
                "text": "{\\n  \\"transcript\\": \\"All right, so here we are in front of the elephants. And the cool thing about these guys is that, is that they have really, really, really long, um, trunks. And that's, that's cool.\\",\\n  \\"onScreenText\\": null,\\n  \\"title\\": \\"A person describing elephants at a zoo\\",\\n  \\"claims\\": [{\\"text\\": \\"Elephants have really long trunks.\\", \\"timestampSeconds\\": 8, \\"quote\\": \\"they have really, really, really long, um, trunks\\"}]\\n}",
                "thoughtSignature": "EvOKCvoKARFNMg9faYTlG4nueJ9hibo"
              }
            ],
            "role": "model"
          },
          "finishReason": "STOP"
        }
      ],
      "usageMetadata": { "promptTokenCount": 1553, "totalTokenCount": 1782 },
      "modelVersion": "gemini-3.6-flash"
    }
    """

    func testParsesLiveResponseShape() throws {
        let analysis = try GeminiVideoClient.parse(Data(Self.liveResponse.utf8))

        XCTAssertTrue(analysis.transcript.hasPrefix("All right, so here we are in front of the elephants."))
        XCTAssertEqual(analysis.title, "A person describing elephants at a zoo")
        XCTAssertNil(analysis.onScreenText)
        XCTAssertEqual(analysis.claims.count, 1)
        XCTAssertEqual(analysis.claims.first?.text, "Elephants have really long trunks.")
        XCTAssertEqual(analysis.claims.first?.timestamp, 8)
        XCTAssertFalse(analysis.truncated)
    }

    /// Parts carrying no `text` at all must be skipped rather than aborting the parse.
    func testSkipsNonTextParts() throws {
        let json = """
        {"candidates":[{"content":{"parts":[
          {"thoughtSignature":"abc"},
          {"text":"{\\"transcript\\":\\"hello\\"}"}
        ]},"finishReason":"STOP"}]}
        """
        let analysis = try GeminiVideoClient.parse(Data(json.utf8))
        XCTAssertEqual(analysis.transcript, "hello")
    }

    func testFlagsTruncatedOutputButKeepsIt() throws {
        let json = """
        {"candidates":[{"content":{"parts":[{"text":"{\\"transcript\\":\\"partial\\"}"}]},
        "finishReason":"MAX_TOKENS"}]}
        """
        let analysis = try GeminiVideoClient.parse(Data(json.utf8))
        XCTAssertEqual(analysis.transcript, "partial")
        XCTAssertTrue(analysis.truncated)
    }

    func testSurfacesSafetyBlockAsEmptyResult() {
        let json = #"{"promptFeedback":{"blockReason":"SAFETY"}}"#
        XCTAssertThrowsError(try GeminiVideoClient.parse(Data(json.utf8))) { error in
            guard case ExtractionError.emptyResult(let reason) = error else {
                return XCTFail("expected emptyResult, got \(error)")
            }
            XCTAssertTrue(reason.contains("SAFETY"))
        }
    }

    func testStripsMarkdownCodeFence() throws {
        let fenced = "```json\n{\"transcript\": \"fenced\"}\n```"
        let analysis = try GeminiVideoAnalysis.decode(from: fenced)
        XCTAssertEqual(analysis.transcript, "fenced")
    }

    func testClaimsWithoutTextAreDropped() throws {
        let inner = #"{"transcript":"t","claims":[{"text":""},{"timestampSeconds":3},{"text":"real claim"}]}"#
        let json = """
        {"candidates":[{"content":{"parts":[{"text":\(jsonStringLiteral(inner))}]}}]}
        """
        let analysis = try GeminiVideoClient.parse(Data(json.utf8))
        XCTAssertEqual(analysis.claims.map(\.text), ["real claim"])
    }

    private func jsonStringLiteral(_ value: String) -> String {
        String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
    }
}

final class GeminiModelChainTests: XCTestCase {
    /// The order specified for this project: 3.6, then 3.5, 3, 2.5, 2.
    func testDefaultChainOrder() {
        XCTAssertEqual(
            GeminiModelChain.flashPreferred.models.map(\.rawValue),
            ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview",
             "gemini-2.5-flash", "gemini-2.0-flash"]
        )
    }

    func testFallsThroughOnModelUnavailable() {
        XCTAssertTrue(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 404, message: "models/gemini-3.6-flash is not found"
        )))
        XCTAssertTrue(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 403, message: "not entitled"
        )))
        XCTAssertTrue(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 400, message: "File data is not supported for this model"
        )))
    }

    /// Rate limits and server errors are the retry layer's job. Falling through would
    /// burn the whole chain on a transient blip and land on the weakest model.
    func testDoesNotFallThroughOnTransientFailures() {
        XCTAssertFalse(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 429, message: "rate limited"
        )))
        XCTAssertFalse(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 503, message: "overloaded"
        )))
        XCTAssertFalse(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 400, message: "request payload is malformed"
        )))
    }
}

final class GeminiChainWalkTests: XCTestCase {
    private func makeClient(
        transport: StubTransport,
        chain: GeminiModelChain = .flashPreferred
    ) -> GeminiVideoClient {
        GeminiVideoClient(
            transport: transport,
            secrets: InMemorySecretStore([.geminiAPIKey: "test-key"]),
            chain: chain,
            policy: RetryPolicy(maxRetries: 0, overallTimeout: 5),
            sleeper: ImmediateSleeper()
        )
    }

    private static let successBody = #"""
    {"candidates":[{"content":{"parts":[{"text":"{\"transcript\":\"ok\"}"}]},"finishReason":"STOP"}]}
    """#

    func testUsesPreferredModelWhenAvailable() async throws {
        let transport = StubTransport([.ok(Self.successBody)])
        let result = try await makeClient(transport: transport)
            .analyzeVideo(at: URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw")!)

        XCTAssertEqual(result.model, .flash3_6)
        let paths = await transport.requestedPaths
        XCTAssertEqual(paths.count, 1)
        XCTAssertTrue(paths[0].contains("gemini-3.6-flash"))
    }

    func testWalksChainPastUnavailableModels() async throws {
        // 3.6 retired, 3.5 not entitled, 3 answers.
        let transport = StubTransport([
            .error(404, message: "models/gemini-3.6-flash is not found"),
            .error(403, message: "caller does not have permission"),
            .ok(Self.successBody),
        ])
        let result = try await makeClient(transport: transport)
            .analyzeVideo(at: URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw")!)

        XCTAssertEqual(result.model, .flash3)
        let paths = await transport.requestedPaths
        XCTAssertEqual(paths.count, 3)
        XCTAssertTrue(paths[0].contains("gemini-3.6-flash"))
        XCTAssertTrue(paths[1].contains("gemini-3.5-flash"))
        XCTAssertTrue(paths[2].contains("gemini-3-flash-preview"))
    }

    func testStopsAtFirstNonAvailabilityFailure() async {
        // A malformed request is our bug — trying it on four more models wastes time
        // and money to reach the same answer.
        let transport = StubTransport([.error(400, message: "request payload is malformed")])
        do {
            _ = try await makeClient(transport: transport)
                .analyzeVideo(at: URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw")!)
            XCTFail("expected failure")
        } catch {
            let count = await transport.requestCount
            XCTAssertEqual(count, 1, "must not walk the chain on a non-availability error")
        }
    }

    func testReportsEveryAttemptWhenAllModelsFail() async {
        let transport = StubTransport(Array(repeating: .error(404, message: "gone"), count: 5))
        do {
            _ = try await makeClient(transport: transport)
                .analyzeVideo(at: URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw")!)
            XCTFail("expected allCandidatesFailed")
        } catch let error as ExtractionError {
            guard case .allCandidatesFailed(let attempts) = error else {
                return XCTFail("expected allCandidatesFailed, got \(error)")
            }
            XCTAssertEqual(attempts.count, 5)
            XCTAssertTrue(attempts[0].contains("gemini-3.6-flash"))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    /// The key goes in a header, not the query string — query strings leak into logs.
    func testSendsAPIKeyAsHeaderNotQueryParameter() async throws {
        let transport = StubTransport([.ok(Self.successBody)])
        _ = try await makeClient(transport: transport)
            .analyzeVideo(at: URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw")!)

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-goog-api-key"), "test-key")
        XCTAssertFalse(request.url!.absoluteString.contains("test-key"))
    }

    func testSendsYouTubeURLAsFileDataPart() async throws {
        let transport = StubTransport([.ok(Self.successBody)])
        _ = try await makeClient(transport: transport)
            .analyzeVideo(at: URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw")!)

        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let contents = try XCTUnwrap(json["contents"] as? [[String: Any]])
        let parts = try XCTUnwrap(contents.first?["parts"] as? [[String: Any]])
        let fileData = try XCTUnwrap(parts.first?["file_data"] as? [String: Any])

        XCTAssertEqual(fileData["file_uri"] as? String, "https://www.youtube.com/watch?v=jNQXAC9IVRw")
    }

    func testMaxDurationBecomesAClipWindow() async throws {
        let transport = StubTransport([.ok(Self.successBody)])
        let extractor = YouTubeExtractor(client: makeClient(transport: transport), maxDuration: 600)
        _ = try await extractor.extract(from: URL(string: "https://youtu.be/jNQXAC9IVRw")!)

        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let contents = try XCTUnwrap(json["contents"] as? [[String: Any]])
        let parts = try XCTUnwrap(contents.first?["parts"] as? [[String: Any]])
        let videoMetadata = try XCTUnwrap(parts.first?["video_metadata"] as? [String: Any])

        XCTAssertEqual(videoMetadata["start_offset"] as? String, "0s")
        XCTAssertEqual(videoMetadata["end_offset"] as? String, "600s")
    }
}

final class YouTubeExtractorTests: XCTestCase {
    private static let body = #"""
    {"candidates":[{"content":{"parts":[{"text":"{\"transcript\":\"the moon landing was in 1969\",\"title\":\"History clip\",\"claims\":[{\"text\":\"The moon landing was in 1969.\",\"timestampSeconds\":2}]}"}]},"finishReason":"STOP"}]}
    """#

    func testProducesTheSharedContextShape() async throws {
        let transport = StubTransport([.ok(Self.body)])
        let client = GeminiVideoClient(
            transport: transport,
            secrets: InMemorySecretStore([.geminiAPIKey: "k"]),
            policy: RetryPolicy(maxRetries: 0),
            sleeper: ImmediateSleeper()
        )
        let shared = URL(string: "https://youtu.be/jNQXAC9IVRw?t=30")!
        let context = try await YouTubeExtractor(client: client).extract(from: shared)

        XCTAssertEqual(context.transcript, "the moon landing was in 1969")
        XCTAssertEqual(context.provenance.platform, .youTube)
        XCTAssertEqual(context.provenance.strategy, .nativeVideoIngestion)
        // The URL the user shared is preserved, not the canonicalised one — provenance
        // should reflect what they actually sent.
        XCTAssertEqual(context.provenance.sourceURL, shared)
        XCTAssertEqual(context.provenance.extra["videoID"], "jNQXAC9IVRw")
        XCTAssertEqual(context.provenance.extra["geminiModel"], "gemini-3.6-flash")
        XCTAssertEqual(context.candidateClaims.count, 1)
        // Native ingestion never holds pixels, so there are no frames to carry.
        XCTAssertTrue(context.frames.isEmpty)
    }

    func testRejectsNonVideoYouTubeURLs() {
        let client = GeminiVideoClient(
            transport: StubTransport([]),
            secrets: InMemorySecretStore([.geminiAPIKey: "k"])
        )
        let extractor = YouTubeExtractor(client: client)
        XCTAssertFalse(extractor.canHandle(URL(string: "https://www.youtube.com/@channel")!))
        XCTAssertTrue(extractor.canHandle(URL(string: "https://youtu.be/jNQXAC9IVRw")!))
    }
}
