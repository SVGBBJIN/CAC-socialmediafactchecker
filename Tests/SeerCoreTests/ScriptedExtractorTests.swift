import XCTest
@testable import SeerCore

/// The stand-in extractor that drives `SeerUIDemo` and the SwiftUI previews.
///
/// Worth testing rather than waving through, for a specific reason: it is the only thing
/// that will ever exercise the progress animation, and `SeerUI` itself cannot be compiled
/// or tested on Linux. If the scripts drift from the stage sequence a real run produces,
/// the demo quietly starts showing an animation of something that doesn't happen — and
/// there is no other test that would notice.
final class ScriptedExtractorTests: XCTestCase {
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

    private static let tikTokURL =
        URL(string: "https://www.tiktok.com/@scout2015/video/6718335390845095173")!

    private func extractor(
        platform: Platform,
        beats: [ScriptedExtractor.Beat],
        outcome: Result<ClaimContext, ExtractionError>? = nil
    ) -> ScriptedExtractor {
        ScriptedExtractor(
            platform: platform, beats: beats, outcome: outcome, sleeper: ImmediateSleeper()
        )
    }

    // MARK: - Scripts

    /// The scripts are derived from `ExtractionStage.expected(for:)` rather than written
    /// out, so this asserts the derivation rather than a copy of the table.
    func testScriptMatchesTheStagesTheStageTablePromises() {
        for platform in Platform.allCases {
            let scripted = ScriptedExtractor.script(for: platform, pace: 0).map(\.stage)
            let expected = ExtractionStage.expected(for: platform).filter { $0 != .done }
            XCTAssertEqual(scripted, expected, "\(platform.rawValue)")
        }
    }

    func testUploadIsInsertedBeforeAnalysingWhenAskedFor() {
        let stages = ScriptedExtractor.script(for: .tikTok, pace: 0, includeUpload: true).map(\.stage)
        XCTAssertEqual(stages, [.resolving, .fetchingMedia, .uploading, .analysing])
    }

    /// `analysing` has to overrun its patience threshold, or a demo run never reaches the
    /// state the explanation text exists for and the animation can't be judged.
    func testTheAnalysingBeatOutlastsItsPatienceThreshold() throws {
        let analysing = try XCTUnwrap(
            ScriptedExtractor.script(for: .tikTok).first { $0.stage == .analysing }
        )
        let threshold = ExtractionProgress(stage: .analysing, platform: .tikTok).patienceThreshold
        XCTAssertGreaterThan(analysing.duration, threshold)
    }

    // MARK: - Running

    func testWalksItsScriptInOrderAndThePipelineClosesWithDone() async throws {
        let recorder = Recorder()
        let pipeline = ExtractionPipeline(extractors: [
            extractor(
                platform: .tikTok,
                beats: ScriptedExtractor.script(for: .tikTok, pace: 0, includeUpload: true)
            )
        ])

        let context = try await pipeline.extract(
            from: Self.tikTokURL, onProgress: recorder.handler
        )

        XCTAssertEqual(recorder.stages, [.resolving, .fetchingMedia, .uploading, .analysing, .done])
        XCTAssertFalse(context.isEmpty, "an empty context would be rejected by the pipeline")
        XCTAssertEqual(context.provenance.platform, .tikTok)
        XCTAssertEqual(context.provenance.sourceURL, Self.tikTokURL)
    }

    /// Events must be numbered and share one clock, because that is what lets a UI detect
    /// reordering it introduced itself. `AnalysisModel` depends on both.
    func testEventsAreNumberedFromOneAndShareAStartTime() async throws {
        let recorder = Recorder()
        let pipeline = ExtractionPipeline(extractors: [
            extractor(platform: .youTube, beats: ScriptedExtractor.script(for: .youTube, pace: 0))
        ])

        _ = try await pipeline.extract(
            from: URL(string: "https://youtu.be/jNQXAC9IVRw")!, onProgress: recorder.handler
        )

        let events = recorder.events
        XCTAssertEqual(events.map(\.sequence), Array(1...events.count))
        XCTAssertEqual(Set(events.map(\.startedAt)).count, 1)
    }

    /// `done` is the pipeline's to emit. A script that includes it would produce two, and
    /// a stage list that closes twice is exactly the sort of thing nobody notices in a
    /// demo until it is copied into something real.
    func testDoneInAScriptIsDroppedRatherThanEmittedTwice() async throws {
        let recorder = Recorder()
        let pipeline = ExtractionPipeline(extractors: [
            extractor(
                platform: .youTube,
                beats: [
                    ScriptedExtractor.Beat(.resolving),
                    ScriptedExtractor.Beat(.analysing),
                    ScriptedExtractor.Beat(.done),
                ]
            )
        ])

        _ = try await pipeline.extract(
            from: URL(string: "https://youtu.be/jNQXAC9IVRw")!, onProgress: recorder.handler
        )

        XCTAssertEqual(recorder.stages.filter { $0 == .done }.count, 1)
    }

    // MARK: - Routing and failure

    func testSeveralScriptedExtractorsRouteByLinkLikeTheRealOnes() async throws {
        let pipeline = ExtractionPipeline(extractors: [
            extractor(platform: .youTube, beats: ScriptedExtractor.script(for: .youTube, pace: 0)),
            extractor(platform: .tikTok, beats: ScriptedExtractor.script(for: .tikTok, pace: 0)),
        ])

        let youTube = try await pipeline.extract(from: URL(string: "https://youtu.be/jNQXAC9IVRw")!)
        XCTAssertEqual(youTube.provenance.platform, .youTube)

        let tikTok = try await pipeline.extract(from: Self.tikTokURL)
        XCTAssertEqual(tikTok.provenance.platform, .tikTok)

        // Nothing claims an unknown host, so the pipeline's own refusal still applies.
        do {
            _ = try await pipeline.extract(from: URL(string: "https://example.com/x")!)
            XCTFail("expected unsupportedPlatform")
        } catch let error as ExtractionError {
            XCTAssertEqual(error, .unsupportedPlatform(host: "example.com"))
        }
    }

    func testAScriptedFailureSurfacesAfterItsStagesHaveRun() async throws {
        let recorder = Recorder()
        let reason = "screen capture is unresolved — see docs/EXTRACTION_PIPELINE.md"
        let pipeline = ExtractionPipeline(extractors: [
            extractor(
                platform: .instagram,
                beats: [ScriptedExtractor.Beat(.resolving)],
                outcome: .failure(.captureUnavailable(reason: reason))
            )
        ])

        do {
            _ = try await pipeline.extract(
                from: URL(string: "https://www.instagram.com/reel/CxAmpleReel/")!,
                onProgress: recorder.handler
            )
            XCTFail("expected captureUnavailable")
        } catch let error as ExtractionError {
            XCTAssertEqual(error, .captureUnavailable(reason: reason))
        }

        // The stages it did reach were still reported — a failed run has a shape too, and
        // the UI shows how far it got.
        XCTAssertEqual(recorder.stages, [.resolving])
    }
}
