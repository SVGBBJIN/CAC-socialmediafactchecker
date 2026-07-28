import XCTest
@testable import SeerCore

final class PlatformDetectionTests: XCTestCase {
    func testDetectsPlatformsAcrossHostVariants() {
        let cases: [(String, Platform)] = [
            ("https://www.youtube.com/watch?v=jNQXAC9IVRw", .youTube),
            ("https://youtube.com/watch?v=jNQXAC9IVRw", .youTube),
            ("https://m.youtube.com/watch?v=jNQXAC9IVRw", .youTube),
            ("https://youtu.be/jNQXAC9IVRw", .youTube),
            ("https://www.youtube-nocookie.com/embed/jNQXAC9IVRw", .youTube),
            ("https://www.tiktok.com/@user/video/6718335390845095173", .tikTok),
            ("https://vm.tiktok.com/ZMabcdefg/", .tikTok),
            ("https://uk.tiktok.com/@user/video/123", .tikTok),
            ("https://www.instagram.com/reel/ABCDEFGHIJK/", .instagram),
            ("https://example.com/video/1", .unknown),
        ]
        for (string, expected) in cases {
            let url = URL(string: string)!
            XCTAssertEqual(Platform.detect(from: url), expected, "for \(string)")
        }
    }

    /// The fork is defined once, on `Platform`. If this changes, it should be a
    /// deliberate architectural decision rather than a drive-by edit.
    func testIngestionStrategyFork() {
        XCTAssertEqual(Platform.youTube.ingestionStrategy, .nativeVideoIngestion)
        // TikTok's embed page yields a direct CDN URL, so it fetches rather than records.
        XCTAssertEqual(Platform.tikTok.ingestionStrategy, .directMediaFetch)
        // Instagram is login-walled, so it is the only platform left on capture.
        XCTAssertEqual(Platform.instagram.ingestionStrategy, .screenCapture)
    }
}

final class YouTubeURLTests: XCTestCase {
    func testExtractsVideoIDFromEveryShareFormat() {
        let cases: [(String, String?)] = [
            ("https://www.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"),
            ("https://youtu.be/jNQXAC9IVRw", "jNQXAC9IVRw"),
            ("https://youtu.be/jNQXAC9IVRw?t=42", "jNQXAC9IVRw"),
            ("https://www.youtube.com/shorts/jNQXAC9IVRw", "jNQXAC9IVRw"),
            ("https://www.youtube.com/embed/jNQXAC9IVRw", "jNQXAC9IVRw"),
            ("https://www.youtube.com/live/jNQXAC9IVRw", "jNQXAC9IVRw"),
            // Share links carry extra parameters; the ID must still come out.
            ("https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLabc&index=2&t=90s", "jNQXAC9IVRw"),
            // Not a single video — must be rejected, not guessed at.
            ("https://www.youtube.com/@someChannel", nil),
            ("https://www.youtube.com/playlist?list=PLabcdefghij", nil),
            ("https://www.youtube.com/shorts/not-an-id", nil),
        ]
        for (string, expected) in cases {
            let url = URL(string: string)!
            XCTAssertEqual(YouTubeExtractor.videoID(from: url), expected, "for \(string)")
        }
    }

    func testCanonicalURLStripsTrackingParameters() {
        let shared = URL(string: "https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLx&si=trackingtoken")!
        let id = YouTubeExtractor.videoID(from: shared)!
        XCTAssertEqual(
            YouTubeExtractor.canonicalURL(for: id).absoluteString,
            "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        )
    }

    func testValidatesIDShape() {
        XCTAssertTrue(YouTubeExtractor.isValidVideoID("jNQXAC9IVRw"))
        XCTAssertTrue(YouTubeExtractor.isValidVideoID("a-b_c1234XY"))
        XCTAssertFalse(YouTubeExtractor.isValidVideoID("tooshort"))
        XCTAssertFalse(YouTubeExtractor.isValidVideoID("waaaaaytoolongforanid"))
        XCTAssertFalse(YouTubeExtractor.isValidVideoID("has spaces"))
    }
}

final class PipelineRoutingTests: XCTestCase {
    private struct StubExtractor: ClaimExtractor {
        let platform: Platform
        var transcript: String = "stub"
        func canHandle(_ url: URL) -> Bool { Platform.detect(from: url) == platform }
        func extract(from url: URL, progress: ProgressSink) async throws -> ClaimContext {
            progress.send(.resolving)
            progress.send(.analysing)
            return ClaimContext(
                transcript: transcript,
                provenance: ProvenanceMetadata(
                    platform: platform, sourceURL: url, strategy: platform.ingestionStrategy
                )
            )
        }
    }

    func testRoutesToTheMatchingExtractor() async throws {
        let pipeline = ExtractionPipeline(extractors: [
            StubExtractor(platform: .youTube, transcript: "from youtube"),
            StubExtractor(platform: .tikTok, transcript: "from tiktok"),
        ])

        let youTube = try await pipeline.extract(from: URL(string: "https://youtu.be/jNQXAC9IVRw")!)
        XCTAssertEqual(youTube.transcript, "from youtube")
        XCTAssertEqual(youTube.provenance.strategy, .nativeVideoIngestion)

        let tikTok = try await pipeline.extract(
            from: URL(string: "https://www.tiktok.com/@user/video/123")!
        )
        XCTAssertEqual(tikTok.transcript, "from tiktok")
        XCTAssertEqual(tikTok.provenance.strategy, .directMediaFetch)
    }

    /// An unregistered platform must fail clearly rather than falling through to
    /// whichever extractor happens to be first.
    func testUnregisteredPlatformIsRejected() async {
        let pipeline = ExtractionPipeline(extractors: [StubExtractor(platform: .youTube)])
        do {
            _ = try await pipeline.extract(from: URL(string: "https://www.tiktok.com/@u/video/1")!)
            XCTFail("expected unsupportedPlatform")
        } catch let error as ExtractionError {
            guard case .unsupportedPlatform = error else {
                return XCTFail("expected unsupportedPlatform, got \(error)")
            }
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    /// A context with nothing in it is a failure, not a result — otherwise the
    /// fact-check layer reports "no claims found" for a video it never actually read.
    func testEmptyContextIsAnError() async {
        let pipeline = ExtractionPipeline(extractors: [
            StubExtractor(platform: .youTube, transcript: "   ")
        ])
        do {
            _ = try await pipeline.extract(from: URL(string: "https://youtu.be/jNQXAC9IVRw")!)
            XCTFail("expected emptyResult")
        } catch let error as ExtractionError {
            guard case .emptyResult = error else {
                return XCTFail("expected emptyResult, got \(error)")
            }
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}
