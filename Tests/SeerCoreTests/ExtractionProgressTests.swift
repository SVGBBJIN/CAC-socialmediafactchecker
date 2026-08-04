import XCTest
@testable import SeerCore

/// Progress reporting. The stage sequence is the contract a UI animates against, so it
/// is asserted per platform rather than left to whatever the extractors happen to emit.
final class ExtractionProgressTests: XCTestCase {
    /// Collects events in the order they were emitted.
    ///
    /// The handler is called synchronously from the pipeline, so appending under a lock
    /// preserves order. Forwarding each event into an actor with its own `Task` — the
    /// first thing one reaches for — does not, and that is worth stating here because
    /// this test file is where someone will copy the pattern from.
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [ExtractionProgress] = []

        var events: [ExtractionProgress] {
            lock.lock(); defer { lock.unlock() }
            return storage
        }
        var stages: [ExtractionStage] { events.map(\.stage) }

        var handler: ProgressSink.Handler {
            { [self] progress in
                lock.lock(); defer { lock.unlock() }
                storage.append(progress)
            }
        }
    }

    // MARK: - Sequences

    func testYouTubeReportsResolvingThenAnalysingThenDone() async throws {
        let json = #"""
        {"candidates":[{"content":{"parts":[{"text":"{\"transcript\":\"hello\"}"}]},"finishReason":"STOP"}]}
        """#
        let pipeline = ExtractionPipeline(extractors: [
            YouTubeExtractor(
                client: GeminiVideoClient(
                    transport: StubTransport([.ok(json)]),
                    secrets: InMemorySecretStore([.geminiAPIKey: "k"]),
                    chain: GeminiModelChain([.flash3_6]),
                    sleeper: ImmediateSleeper()
                )
            )
        ])

        let recorder = Recorder()
        _ = try await pipeline.extract(
            from: URL(string: "https://youtu.be/jNQXAC9IVRw")!,
            onProgress: recorder.handler
        )

        let stages = recorder.stages
        XCTAssertEqual(stages, [.resolving, .analysing, .done])

        let events = recorder.events
        XCTAssertTrue(events.allSatisfy { $0.platform == .youTube })
        // One clock for the whole run, so elapsed time in a UI matches the real wait.
        XCTAssertEqual(Set(events.map(\.startedAt)).count, 1)
    }

    func testTikTokReportsTheDownloadStage() async throws {
        let recorder = Recorder()
        let pipeline = ExtractionPipeline(extractors: [
            DirectMediaExtractorTests.extractor(
                transport: StubTransport([.ok(DirectMediaExtractorTests.geminiJSON)])
            )
        ])

        _ = try await pipeline.extract(
            from: DirectMediaExtractorTests.sourceURL,
            onProgress: recorder.handler
        )

        let stages = recorder.stages
        XCTAssertEqual(stages, [.resolving, .fetchingMedia, .analysing, .done])
    }

    /// The upload stage exists only for clips too large to send inline, which is why it
    /// isn't in `expected(for:)` — a UI inserts it when it arrives.
    func testLargeClipReportsAnUploadStage() async throws {
        let filesTransport = StubTransport([
            .init(
                status: 200, body: Data(),
                headers: ["X-Goog-Upload-URL": GeminiFilesClientTests.uploadSessionURL]
            ),
            .ok(#"{"file":{"name":"files/x","uri":"u","mimeType":"video/mp4","state":"ACTIVE"}}"#),
        ])
        let pipeline = ExtractionPipeline(extractors: [
            DirectMediaExtractorTests.extractor(
                transport: StubTransport([.ok(DirectMediaExtractorTests.geminiJSON)]),
                downloadBytes: 4096,
                inlineByteLimit: 1024,
                filesClient: GeminiFilesClientTests.client(filesTransport)
            )
        ])

        let recorder = Recorder()
        _ = try await pipeline.extract(
            from: DirectMediaExtractorTests.sourceURL,
            onProgress: recorder.handler
        )

        let stages = recorder.stages
        XCTAssertEqual(stages, [.resolving, .fetchingMedia, .uploading, .analysing, .done])

        // The size is carried through so the UI can say what it is waiting on.
        let events = recorder.events
        let upload = try XCTUnwrap(events.first { $0.stage == .uploading })
        XCTAssertEqual(upload.detail, "0.0 MB")
    }

    /// `done` means the pipeline accepted the result. An extraction that produced
    /// nothing usable has not finished successfully, however far it got.
    func testDoneIsNotReportedWhenTheResultIsEmpty() async throws {
        let json = #"""
        {"candidates":[{"content":{"parts":[{"text":"{\"transcript\":\"\",\"claims\":[]}"}]},"finishReason":"STOP"}]}
        """#
        let pipeline = ExtractionPipeline(extractors: [
            YouTubeExtractor(
                client: GeminiVideoClient(
                    transport: StubTransport([.ok(json)]),
                    secrets: InMemorySecretStore([.geminiAPIKey: "k"]),
                    chain: GeminiModelChain([.flash3_6]),
                    sleeper: ImmediateSleeper()
                )
            )
        ])

        let recorder = Recorder()
        _ = try? await pipeline.extract(
            from: URL(string: "https://youtu.be/jNQXAC9IVRw")!,
            onProgress: recorder.handler
        )

        let stages = recorder.stages
        XCTAssertFalse(stages.contains(.done))
        XCTAssertEqual(stages, [.resolving, .analysing])
    }

    /// A failure part-way leaves the last stage reported, which is what tells you where
    /// it broke.
    func testStagesUpToTheFailureAreReported() async throws {
        let pipeline = ExtractionPipeline(extractors: [
            DirectMediaExtractorTests.extractor(
                transport: StubTransport([.error(500, message: "boom")]),
                downloadBytes: 512
            )
        ])

        let recorder = Recorder()
        _ = try? await pipeline.extract(
            from: DirectMediaExtractorTests.sourceURL,
            onProgress: recorder.handler
        )

        let stages = recorder.stages
        XCTAssertEqual(stages.last, .analysing, "the failing stage must be the last reported")
        XCTAssertFalse(stages.contains(.done))
    }

    /// Progress is opt-in and must cost nothing when unused.
    func testExtractionWorksWithoutAProgressHandler() async throws {
        let json = #"""
        {"candidates":[{"content":{"parts":[{"text":"{\"transcript\":\"hi\"}"}]},"finishReason":"STOP"}]}
        """#
        let pipeline = ExtractionPipeline(extractors: [
            YouTubeExtractor(
                client: GeminiVideoClient(
                    transport: StubTransport([.ok(json)]),
                    secrets: InMemorySecretStore([.geminiAPIKey: "k"]),
                    chain: GeminiModelChain([.flash3_6]),
                    sleeper: ImmediateSleeper()
                )
            )
        ])
        let context = try await pipeline.extract(from: URL(string: "https://youtu.be/jNQXAC9IVRw")!)
        XCTAssertEqual(context.transcript, "hi")
    }

    // MARK: - Presentation

    /// The copy the user actually reads. Tested here so a share extension, a widget and
    /// a debug log can't drift apart.
    func testLabelsNameThePlatform() {
        XCTAssertEqual(
            ExtractionProgress(stage: .analysing, platform: .youTube).label,
            "Analyzing your YouTube video"
        )
        XCTAssertEqual(
            ExtractionProgress(stage: .analysing, platform: .tikTok).label,
            "Analyzing your TikTok video"
        )
        XCTAssertEqual(
            ExtractionProgress(stage: .resolving, platform: .youTube).label,
            "Reading the YouTube link"
        )
        XCTAssertEqual(
            ExtractionProgress(stage: .fetchingMedia, platform: .tikTok).label,
            "Downloading the video"
        )
    }

    func testExpectedStagesMatchEachPlatformsPath() {
        XCTAssertEqual(
            ExtractionStage.expected(for: .youTube), [.resolving, .analysing, .done]
        )
        XCTAssertEqual(
            ExtractionStage.expected(for: .tikTok),
            [.resolving, .fetchingMedia, .analysing, .done]
        )
        // Conditional on byte count, so it is inserted when it happens rather than
        // shown up front and skipped.
        XCTAssertFalse(ExtractionStage.expected(for: .tikTok).contains(.uploading))
    }

    /// The expected sequence has to match what the extractors really emit, or a UI lays
    /// out rows that never fill in.
    func testExpectedStagesAgreeWithWhatIsEmitted() async throws {
        let recorder = Recorder()
        let pipeline = ExtractionPipeline(extractors: [
            DirectMediaExtractorTests.extractor(
                transport: StubTransport([.ok(DirectMediaExtractorTests.geminiJSON)])
            )
        ])
        _ = try await pipeline.extract(
            from: DirectMediaExtractorTests.sourceURL,
            onProgress: recorder.handler
        )

        let stages = recorder.stages
        XCTAssertEqual(stages, ExtractionStage.expected(for: .tikTok))
    }

    /// Long stages need a point at which silence stops being normal. Analysing is the
    /// one that actually overruns, so it must not be the most patient.
    func testPatienceThresholdsAreOrderedSensibly() {
        let resolving = ExtractionProgress(stage: .resolving, platform: .youTube)
        let analysing = ExtractionProgress(stage: .analysing, platform: .youTube)
        XCTAssertLessThan(resolving.patienceThreshold, analysing.patienceThreshold)
        XCTAssertEqual(ExtractionProgress(stage: .done, platform: .youTube).patienceThreshold, .infinity)
        XCTAssertNotNil(analysing.explanation)
        XCTAssertNil(ExtractionProgress(stage: .done, platform: .youTube).explanation)
    }

    func testIgnoredSinkDropsEverything() {
        // Nothing to assert beyond "does not trap"; the point is that extractors need no
        // nil-checking around every send.
        ProgressSink.ignored.send(.analysing, detail: "x")
    }

    // MARK: - Ordering

    /// Events carry a monotonic sequence number so a consumer can detect reordering it
    /// introduced itself.
    ///
    /// This is not hypothetical. The obvious bridge to the main actor —
    /// `Task { @MainActor in apply(p) }` per event — spawns unordered tasks, and it
    /// reordered stages the first time it was written here. `AnalysisModel` consumes an
    /// `AsyncStream` instead, and checks this number as a backstop.
    func testEventsAreNumberedMonotonically() async throws {
        let pipeline = ExtractionPipeline(extractors: [
            DirectMediaExtractorTests.extractor(
                transport: StubTransport([.ok(DirectMediaExtractorTests.geminiJSON)])
            )
        ])
        let recorder = Recorder()
        _ = try await pipeline.extract(
            from: DirectMediaExtractorTests.sourceURL,
            onProgress: recorder.handler
        )

        let sequences = recorder.events.map(\.sequence)
        XCTAssertEqual(sequences, [1, 2, 3, 4])
        XCTAssertEqual(sequences, sequences.sorted(), "sequence numbers must increase")
    }

    /// Numbering has to survive the sink being copied into nested `async` calls — it is a
    /// struct, so every hop takes a copy, and all copies of one run's sink have to share
    /// the counter or the numbers repeat.
    func testSequenceIsSharedAcrossSinkCopies() {
        let recorder = Recorder()
        let sink = ProgressSink(platform: .tikTok, handler: recorder.handler)

        sink.send(.resolving)
        let copy = sink
        copy.send(.fetchingMedia)
        // The original must not restart the count after the copy has advanced it.
        sink.send(.analysing)

        XCTAssertEqual(recorder.events.map(\.sequence), [1, 2, 3])
        XCTAssertEqual(recorder.events.map(\.platform), [.tikTok, .tikTok, .tikTok])
    }

    /// An `AsyncStream` is the ordering-safe bridge, and this is the pattern `SeerUI`
    /// uses. Asserted here because `SeerUI` cannot be compiled or tested on Linux.
    func testAsyncStreamBridgePreservesOrder() async throws {
        let (stream, continuation) = AsyncStream<ExtractionProgress>.makeStream()
        let collector = Task { () -> [ExtractionStage] in
            var seen: [ExtractionStage] = []
            for await progress in stream { seen.append(progress.stage) }
            return seen
        }

        let pipeline = ExtractionPipeline(extractors: [
            DirectMediaExtractorTests.extractor(
                transport: StubTransport([.ok(DirectMediaExtractorTests.geminiJSON)])
            )
        ])
        _ = try await pipeline.extract(from: DirectMediaExtractorTests.sourceURL) { progress in
            continuation.yield(progress)
        }
        continuation.finish()

        let seen = await collector.value
        XCTAssertEqual(seen, [.resolving, .fetchingMedia, .analysing, .done])
    }
}
