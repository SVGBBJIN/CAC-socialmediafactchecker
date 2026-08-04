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

    /// A thinking summary is a text part like any other on the wire, distinguished only
    /// by `thought: true`. The whole joined string is handed to the JSON decoder, so a
    /// summary concatenated in front of the object fails the parse outright.
    func testDropsThinkingSummaryParts() throws {
        let json = """
        {"candidates":[{"content":{"parts":[
          {"text":"Let me watch the clip and enumerate the claims.","thought":true},
          {"text":"{\\"transcript\\":\\"hello\\"}","thoughtSignature":"abc"}
        ]},"finishReason":"STOP"}]}
        """
        let analysis = try GeminiVideoClient.parse(Data(json.utf8))
        XCTAssertEqual(analysis.transcript, "hello")
    }

    /// `thought: false` is the answer, not a summary — it must not be filtered too.
    func testKeepsPartsExplicitlyMarkedNotThought() throws {
        let json = """
        {"candidates":[{"content":{"parts":[
          {"text":"{\\"transcript\\":\\"hello\\"}","thought":false}
        ]},"finishReason":"STOP"}]}
        """
        XCTAssertEqual(try GeminiVideoClient.parse(Data(json.utf8)).transcript, "hello")
    }

    /// Nothing but summaries is no analysis at all, and reads as an empty result rather
    /// than as a decode failure.
    func testAResponseOfNothingButThoughtsIsEmpty() {
        let json = """
        {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}]},
        "finishReason":"STOP"}]}
        """
        XCTAssertThrowsError(try GeminiVideoClient.parse(Data(json.utf8))) { error in
            guard case ExtractionError.emptyResult(let reason) = error else {
                return XCTFail("expected emptyResult, got \(error)")
            }
            XCTAssertTrue(reason.contains("no text"), "got \(reason)")
        }
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

    /// What a real MAX_TOKENS response looks like: the JSON stops mid-string, because the
    /// model ran out of output budget partway through writing it.
    ///
    /// The test above hands `parse` *complete* JSON and only sets the finish reason, which
    /// is why this case went unnoticed — a strict decode of genuinely truncated output
    /// always fails, so a long video lost its entire transcript to a parse error.
    func testSalvagesTranscriptFromGenuinelyTruncatedJSON() throws {
        let cutOff = #"{"transcript": "The study found that sea levels rose by"#
        let json = """
        {"candidates":[{"content":{"parts":[{"text":\(Self.jsonQuoted(cutOff))}]},
        "finishReason":"MAX_TOKENS"}]}
        """

        let analysis = try GeminiVideoClient.parse(Data(json.utf8))
        XCTAssertEqual(analysis.transcript, "The study found that sea levels rose by")
        XCTAssertTrue(analysis.truncated)
        XCTAssertTrue(analysis.claims.isEmpty, "a half-written claim must never be reported")
    }

    /// Escapes have to survive the salvage, or the recovered transcript misquotes the
    /// speaker — quoted speech is exactly what a fact-checker works from.
    func testSalvagePreservesEscapedCharacters() throws {
        let cutOff = #"{"transcript": "He said \"it doubled\",\nthen paused"#
        let json = """
        {"candidates":[{"content":{"parts":[{"text":\(Self.jsonQuoted(cutOff))}]},
        "finishReason":"MAX_TOKENS"}]}
        """

        let analysis = try GeminiVideoClient.parse(Data(json.utf8))
        XCTAssertEqual(analysis.transcript, "He said \"it doubled\",\nthen paused")
    }

    /// Salvage is only for truncation. Genuinely malformed output still has to fail —
    /// silently inventing an empty result would read downstream as "makes no claims".
    func testMalformedOutputStillFailsWhenNotTruncated() {
        let json = """
        {"candidates":[{"content":{"parts":[{"text":"this is not json at all"}]},
        "finishReason":"STOP"}]}
        """
        XCTAssertThrowsError(try GeminiVideoClient.parse(Data(json.utf8))) { error in
            guard case ExtractionError.malformedResponse = error else {
                return XCTFail("expected malformedResponse, got \(error)")
            }
        }
    }

    /// Truncated *before* the transcript key: there is nothing to recover, so this must
    /// fail rather than hand back an empty transcript.
    func testTruncationWithNothingToSalvageStillFails() {
        let json = """
        {"candidates":[{"content":{"parts":[{"text":"{\\"tit"}]},
        "finishReason":"MAX_TOKENS"}]}
        """
        XCTAssertThrowsError(try GeminiVideoClient.parse(Data(json.utf8))) { error in
            guard case ExtractionError.malformedResponse = error else {
                return XCTFail("expected malformedResponse, got \(error)")
            }
        }
    }

    private static func jsonQuoted(_ value: String) -> String {
        String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
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

    /// A 429 only reaches `shouldFallThrough` after `HTTPTransport` has already retried it
    /// with backoff and honoured any `Retry-After` — so by here it is a quota that is
    /// genuinely spent, not a blip. Gemini meters quota per model, so the next model in
    /// the chain has its own and frequently answers.
    func testFallsThroughOnAnExhaustedQuota() {
        XCTAssertTrue(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 429, message: "rate limited"
        )))
        XCTAssertTrue(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 403, message: "RESOURCE_EXHAUSTED"
        )))
        XCTAssertTrue(isQuotaFailure(status: 400, message: "Quota exceeded for quota metric"))
        XCTAssertFalse(isQuotaFailure(status: 500, message: "quota"), "a 5xx is an outage")
        XCTAssertFalse(isQuotaFailure(status: 400, message: "invalid argument"))
    }

    /// Capacity, like quota, is metered per model — and the newest model in the chain is
    /// the one most likely to be full, so this is the *common* upstream failure rather
    /// than an exotic one. This used to assert the opposite: a 503 was treated as an
    /// outage and killed the request outright while four models that would have answered
    /// went untried.
    func testFallsThroughOnAnOverloadedModel() {
        XCTAssertTrue(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 503, message: "The model is overloaded."
        )))
        XCTAssertTrue(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 500, message: "The service is currently unavailable."
        )))
        XCTAssertTrue(isOverloadedFailure(status: 500, message: "model is busy, try again"))
    }

    /// A bare 500 is an outage, not a full model. Walking the chain through one adds four
    /// more failed requests to a service already in trouble, so the wording is what
    /// separates them — not the status.
    func testDoesNotFallThroughOnTransientFailures() {
        XCTAssertFalse(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 500, message: "internal error"
        )))
        XCTAssertFalse(isOverloadedFailure(status: 502, message: "overloaded"))
        XCTAssertFalse(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 400, message: "request payload is malformed"
        )))
    }

    /// Gemini reports an invalid key as 400, not 401 — captured from the live endpoint
    /// on 2026-07-27. It reads like an ordinary bad request, and the 400 branch above
    /// would otherwise have to be trusted not to match it; assert that directly, because
    /// falling through means re-sending a credential that cannot work to every model
    /// left in the chain.
    func testDoesNotFallThroughOnAnInvalidKey() {
        let liveMessage = "API key not valid. Please pass a valid API key."
        XCTAssertTrue(isInvalidKeyFailure(status: 400, message: liveMessage))
        XCTAssertFalse(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 400, message: liveMessage
        )))
    }

    func testInvalidKeyDetectionDoesNotFireOnUnrelatedFailures() {
        XCTAssertTrue(isInvalidKeyFailure(status: 401, message: "unauthorized"))
        XCTAssertTrue(isInvalidKeyFailure(status: 400, message: "reason: API_KEY_INVALID"))
        XCTAssertFalse(isInvalidKeyFailure(status: 400, message: "Invalid JSON payload received"))
        XCTAssertFalse(isInvalidKeyFailure(status: 400, message: "models/x is not supported"))
        XCTAssertFalse(isInvalidKeyFailure(status: 429, message: "quota exceeded"))
        XCTAssertFalse(isInvalidKeyFailure(status: 500, message: "internal error"))
    }

    /// `supportsThinkingBudget` is a guess from the version number. Gemini rejects an
    /// unknown field name outright rather than ignoring it, so a wrong guess has to cost
    /// one model rather than the whole chain — and the message carries neither "not
    /// supported" nor "unsupported", so the plain 400 branch would not catch it.
    func testFallsThroughWhenAModelRefusesThinkingConfig() {
        let live = #"Invalid JSON payload received. Unknown name "thinkingConfig": Cannot find field."#
        XCTAssertTrue(isUnsupportedThinkingConfig(status: 400, message: live))
        XCTAssertTrue(isUnsupportedThinkingConfig(status: 400, message: #"Unknown name "thinking_config""#))
        XCTAssertFalse(isUnsupportedThinkingConfig(status: 400, message: "request payload is malformed"))
        XCTAssertFalse(isUnsupportedThinkingConfig(status: 500, message: "thinkingConfig"))
        XCTAssertTrue(shouldFallThrough(on: ExtractionError.upstreamFailure(
            service: "Gemini", status: 400, message: live
        )))
    }

    /// The models in the chain do not all have the same context window, so the next one
    /// down genuinely might accept what this one refused.
    func testFallsThroughWhenTheRequestIsTooBigForThisModel() {
        for message in [
            "The input token count (2097152) exceeds the maximum number of tokens allowed",
            "Request payload size exceeds the limit",
            "input is too long",
        ] {
            XCTAssertTrue(isContextLimitFailure(status: 400, message: message), "for \(message)")
            XCTAssertTrue(shouldFallThrough(on: ExtractionError.upstreamFailure(
                service: "Gemini", status: 400, message: message
            )), "for \(message)")
        }
        XCTAssertTrue(isContextLimitFailure(status: 413, message: "request entity too large"))
        XCTAssertFalse(isContextLimitFailure(status: 400, message: "request payload is malformed"))
        XCTAssertFalse(isContextLimitFailure(status: 500, message: "token count"))
    }

    /// "2.0" predates extended thinking and has no budget to cap; everything above it in
    /// the chain does. Matched on the version rather than by name so a new preview ID
    /// needs no code change.
    func testOnlyThinkingModelsGetABudget() {
        for model in [GeminiModel.flash3_6, .flash3_5, .flash3, .flash2_5] {
            XCTAssertTrue(supportsThinkingBudget(model), "for \(model)")
        }
        XCTAssertFalse(supportsThinkingBudget(.flash2))
        // The version, not a stray "2.0" elsewhere in the ID.
        XCTAssertTrue(supportsThinkingBudget("gemini-3.5-flash-20260201"))
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

    /// Without a ceiling this path ran on Gemini's own default and let the `MAX_TOKENS`
    /// salvage absorb the result; without a thinking budget the reasoning and the JSON
    /// draw from one pool, so a model that thinks longer just leaves less of the object.
    func testSendsAnOutputCeilingAndAThinkingBudget() async throws {
        let transport = StubTransport([.ok(Self.successBody)])
        _ = try await makeClient(transport: transport)
            .analyzeVideo(at: URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw")!)

        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let config = try XCTUnwrap(json["generationConfig"] as? [String: Any])

        XCTAssertEqual(config["max_output_tokens"] as? Int, GeminiVideoClient.defaultMaxOutputTokens)
        let thinking = try XCTUnwrap(config["thinking_config"] as? [String: Any])
        XCTAssertEqual(
            thinking["thinking_budget"] as? Int, GeminiVideoClient.defaultThinkingBudgetTokens
        )
        // The caller's own settings survive being budgeted.
        XCTAssertEqual(config["response_mime_type"] as? String, "application/json")
    }

    /// The field does not exist on `gemini-2.0-flash`, and Gemini rejects an unknown name
    /// outright — so the body has to be encoded per model, not once for the whole walk.
    func testDropsTheThinkingBudgetForAModelThatHasNone() async throws {
        // 3.6 out of quota, so the walk lands on 2.0 with a single-model tail.
        let transport = StubTransport([
            .error(429, message: "quota exceeded"),
            .ok(Self.successBody),
        ])
        let client = makeClient(transport: transport, chain: GeminiModelChain([.flash3_6, .flash2]))
        let result = try await client
            .analyzeVideo(at: URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw")!)
        XCTAssertEqual(result.model, .flash2)

        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)

        func config(_ index: Int) throws -> [String: Any] {
            let body = try XCTUnwrap(requests[index].httpBody)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            return try XCTUnwrap(json["generationConfig"] as? [String: Any])
        }

        XCTAssertNotNil(try config(0)["thinking_config"], "3.6 thinks and takes a budget")
        XCTAssertNil(try config(1)["thinking_config"], "2.0 has no budget to cap")
        // The ceiling is not a thinking-model field and applies either way.
        XCTAssertEqual(try config(1)["max_output_tokens"] as? Int,
                       GeminiVideoClient.defaultMaxOutputTokens)
    }

    /// A budget of 0 means "send no `thinkingConfig` at all".
    func testAZeroBudgetSendsNoThinkingConfig() async throws {
        let transport = StubTransport([.ok(Self.successBody)])
        let client = GeminiVideoClient(
            transport: transport,
            secrets: InMemorySecretStore([.geminiAPIKey: "test-key"]),
            policy: RetryPolicy(maxRetries: 0),
            sleeper: ImmediateSleeper(),
            thinkingBudgetTokens: 0
        )
        _ = try await client.analyzeVideo(at: URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw")!)

        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let config = try XCTUnwrap(json["generationConfig"] as? [String: Any])
        XCTAssertNil(config["thinking_config"])
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
