import XCTest
@testable import SeerCore

/// The direct-fetch path: TikTok URL → embed page → CDN URL → Gemini.
///
/// The embed payload below is **real**. It was captured from
/// `https://www.tiktok.com/embed/v2/6718335390845095173` on 2026-07-28 with an
/// anonymous request; only the signed query strings on the media and cover URLs are
/// shortened, because they expire. Testing the parser against what TikTok actually
/// serves rather than against a hand-written idea of it is the point — this is an
/// undocumented internal payload, and a fixture invented from the docs would prove
/// nothing about whether the parser works.
final class TikTokEmbedParsingTests: XCTestCase {
    static let liveStateBlob = #"""
    {"source":{"data":{"/embed/v2/6718335390845095173":{"code":200,"isError":false,"videoData":{"itemInfos":{"id":"6718335390845095173","text":"Scramble up ur name & I’ll try to guess it😍❤️ #foryoupage #petsoftiktok #aesthetic","createTime":"1564234358","covers":["https://p16-common-sign.tiktokcdn-us.com/tos-maliva-p-0068/2367c7d45cf54a1397abd0e72bf22eac~tplv-tiktokx-origin.image"],"video":{"urls":["https://v16m.tiktokcdn-us.com/d838b2be25adb61a68f7fbe5d74e9f63/6a6ab84a/video/tos/useast5/tos-useast5-ve-0068c002-tx/15fbafb086324317bf77a649580b1f95/?a=1233&mime_type=video_mp4"],"videoMeta":{"width":576,"height":1024,"ratio":10,"duration":10}}},"authorInfos":{"nickName":"Scout, Suki & Stella","uniqueId":"scout2015"}}}}}}
    """#

    /// The page wraps the blob in the same script tag the live one does.
    static func livePage(blob: String? = nil) -> Data {
        Data("""
        <!DOCTYPE html><html><head><title>TikTok</title></head><body>
        <div id="main"></div>
        <script id="__FRONTITY_CONNECT_STATE__" type="application/json">\(blob ?? liveStateBlob)</script>
        <script src="/embed.js"></script>
        </body></html>
        """.utf8)
    }

    static let sourceURL = URL(string: "https://www.tiktok.com/@scout2015/video/6718335390845095173")!
    static let videoID = "6718335390845095173"

    func testParsesLiveEmbedPage() throws {
        let media = try TikTokMediaResolver.parse(
            Self.livePage(), sourceURL: Self.sourceURL, videoID: Self.videoID
        )

        XCTAssertEqual(media.platform, .tikTok)
        XCTAssertEqual(media.mediaURL.host, "v16m.tiktokcdn-us.com")
        XCTAssertEqual(media.mimeType, "video/mp4")
        XCTAssertEqual(media.duration, 10)
        XCTAssertEqual(media.authorName, "Scout, Suki & Stella")
        XCTAssertEqual(media.caption, "Scramble up ur name & I’ll try to guess it😍❤️ #foryoupage #petsoftiktok #aesthetic")
        XCTAssertEqual(media.extra["dimensions"], "576x1024")
        XCTAssertEqual(media.extra["videoID"], Self.videoID)
        XCTAssertNotNil(media.thumbnailURL)
        // Matches what the embed player sends, in case the CDN ever starts checking.
        XCTAssertEqual(media.referer?.absoluteString, "https://www.tiktok.com/")
    }

    /// The live page names `__FRONTITY_CONNECT_STATE__` more than once — the state blob,
    /// then bootstrap code referring to `window.__FRONTITY_CONNECT_STATE__`. Keying off
    /// the first occurrence is the obvious implementation and the wrong one.
    func testFindsTheStateBlobPastEarlierMentionsOfTheName() throws {
        let page = Data("""
        <html><body>
        <script>window.__FRONTITY_CONNECT_STATE__ = window.__FRONTITY_CONNECT_STATE__ || {};</script>
        <script id="__FRONTITY_CONNECT_STATE__" type="application/json">\(Self.liveStateBlob)</script>
        <script>hydrate(window.__FRONTITY_CONNECT_STATE__);</script>
        </body></html>
        """.utf8)
        let media = try TikTokMediaResolver.parse(
            page, sourceURL: Self.sourceURL, videoID: Self.videoID
        )
        XCTAssertEqual(media.duration, 10)
        XCTAssertEqual(media.authorName, "Scout, Suki & Stella")
    }

    /// When TikTok changes the page shape, the error has to name what went missing —
    /// that is the difference between a ten-minute fix and a re-investigation.
    func testMissingStateBlobFailsWithADiagnosticMessage() {
        let page = Data("<html><body>no blob here</body></html>".utf8)
        XCTAssertThrowsError(
            try TikTokMediaResolver.parse(page, sourceURL: Self.sourceURL, videoID: Self.videoID)
        ) { error in
            guard case ExtractionError.malformedResponse(let detail) = error else {
                return XCTFail("expected malformedResponse, got \(error)")
            }
            XCTAssertTrue(detail.contains("__FRONTITY_CONNECT_STATE__"))
            XCTAssertTrue(detail.contains("shape has changed"))
        }
    }

    /// A private, removed or region-blocked post renders a valid page with no video.
    /// That is an empty result, not a malformed one — the distinction decides whether
    /// the user is told "we can't read this link" or "that video isn't available".
    func testPageWithoutVideoDataIsAnEmptyResult() {
        let blob = #"{"source":{"data":{"/embed/v2/6718335390845095173":{"code":10204,"isError":true}}}}"#
        XCTAssertThrowsError(
            try TikTokMediaResolver.parse(
                Self.livePage(blob: blob), sourceURL: Self.sourceURL, videoID: Self.videoID
            )
        ) { error in
            guard case ExtractionError.emptyResult(let reason) = error else {
                return XCTFail("expected emptyResult, got \(error)")
            }
            XCTAssertTrue(reason.contains("private"), reason)
        }
    }

    func testVideoWithNoPlayableSourceIsAnEmptyResult() {
        let blob = #"""
        {"source":{"data":{"/embed/v2/6718335390845095173":{"videoData":{"itemInfos":{"id":"x","video":{"urls":[]}}}}}}}
        """#
        XCTAssertThrowsError(
            try TikTokMediaResolver.parse(
                Self.livePage(blob: blob), sourceURL: Self.sourceURL, videoID: Self.videoID
            )
        ) { error in
            guard case ExtractionError.emptyResult = error else {
                return XCTFail("expected emptyResult, got \(error)")
            }
        }
    }

    /// Fields we don't read must be free to appear and disappear; the ones we do read
    /// must not. Otherwise a routine addition upstream breaks extraction in the field.
    func testUnknownFieldsAreIgnored() throws {
        let blob = #"""
        {"unexpectedTopLevel":1,"source":{"data":{"/embed/v2/6718335390845095173":{"newKey":"x","videoData":{"itemInfos":{"id":"6718335390845095173","brandNewField":{"a":[1,2]},"video":{"urls":["https://cdn.example/v.mp4"],"videoMeta":{"duration":9,"futureField":true}}},"authorInfos":{"nickName":"n"}}}}}}
        """#
        let media = try TikTokMediaResolver.parse(
            Self.livePage(blob: blob), sourceURL: Self.sourceURL, videoID: Self.videoID
        )
        XCTAssertEqual(media.mediaURL.absoluteString, "https://cdn.example/v.mp4")
        XCTAssertEqual(media.duration, 9)
    }

    /// The blob keys its payload by route. A mismatched ID must not silently pick up
    /// whatever else is in there.
    func testStateForADifferentVideoIsRejected() {
        XCTAssertThrowsError(
            try TikTokMediaResolver.parse(
                Self.livePage(), sourceURL: Self.sourceURL, videoID: "9999999999999999999"
            )
        ) { error in
            guard case ExtractionError.malformedResponse(let detail) = error else {
                return XCTFail("expected malformedResponse, got \(error)")
            }
            XCTAssertTrue(detail.contains("9999999999999999999"))
        }
    }
}

final class TikTokURLTests: XCTestCase {
    func testExtractsVideoIDFromEveryShareFormat() {
        let cases: [(String, String?)] = [
            ("https://www.tiktok.com/@scout2015/video/6718335390845095173", "6718335390845095173"),
            ("https://www.tiktok.com/@user/video/7300000000000000000?is_from_webapp=1&sender_device=pc",
             "7300000000000000000"),
            ("https://m.tiktok.com/v/6718335390845095173.html", "6718335390845095173"),
            ("https://www.tiktok.com/embed/v2/6718335390845095173", "6718335390845095173"),
            ("https://www.tiktok.com/embed/6718335390845095173", "6718335390845095173"),
            ("https://uk.tiktok.com/@user/video/7300000000000000000", "7300000000000000000"),
            // Photo carousels are real posts with no video to fetch.
            ("https://www.tiktok.com/@user/photo/7300000000000000000", nil),
            // Short links carry no ID; they have to be followed.
            ("https://vm.tiktok.com/ZMabcdef/", nil),
            ("https://www.tiktok.com/t/ZTabcdef/", nil),
            // Profile and tag pages are not videos.
            ("https://www.tiktok.com/@scout2015", nil),
            ("https://www.tiktok.com/tag/foryoupage", nil),
            // A slug where the ID should be must not be sent upstream as an ID.
            ("https://www.tiktok.com/@user/video/not-a-number", nil),
        ]
        for (string, expected) in cases {
            let url = URL(string: string)!
            XCTAssertEqual(TikTokURL.videoID(from: url), expected, "for \(string)")
        }
    }

    func testIdentifiesShortLinks() {
        let short = [
            "https://vm.tiktok.com/ZMabcdef/",
            "https://vt.tiktok.com/ZSabcdef/",
            "https://www.tiktok.com/t/ZTabcdef/",
        ]
        for string in short {
            XCTAssertTrue(TikTokURL.isShortLink(URL(string: string)!), "for \(string)")
        }
        let notShort = [
            "https://www.tiktok.com/@scout2015/video/6718335390845095173",
            "https://www.tiktok.com/@scout2015",
        ]
        for string in notShort {
            XCTAssertFalse(TikTokURL.isShortLink(URL(string: string)!), "for \(string)")
        }
    }

    /// Platform routing has to accept the short-link hosts, or the resolver never runs.
    func testShortLinkHostsRouteToTikTok() {
        for string in ["https://vm.tiktok.com/ZMabcdef/", "https://vt.tiktok.com/ZSabcdef/"] {
            XCTAssertEqual(Platform.detect(from: URL(string: string)!), .tikTok, "for \(string)")
        }
    }
}

final class TikTokResolverNetworkTests: XCTestCase {
    /// A deleted or unknown ID comes back from the embed endpoint as a 400, not a 404.
    /// Verified live on 2026-07-28. Surfacing that raw would tell the user TikTok
    /// rejected our request, which is both wrong and unactionable.
    func testUnknownVideoBecomesNotAMediaURL() async {
        let transport = StubTransport([.error(400, message: "Bad Request")])
        let resolver = TikTokMediaResolver(
            transport: transport, policy: .metadata, sleeper: ImmediateSleeper()
        )
        do {
            _ = try await resolver.resolve(
                URL(string: "https://www.tiktok.com/@u/video/1234567890123456789")!
            )
            XCTFail("expected notAMediaURL")
        } catch let error as ExtractionError {
            guard case .notAMediaURL = error else {
                return XCTFail("expected notAMediaURL, got \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testRequestsTheEmbedPageForTheVideoID() async throws {
        let transport = StubTransport([
            .init(status: 200, body: TikTokEmbedParsingTests.livePage())
        ])
        let resolver = TikTokMediaResolver(
            transport: transport, policy: .metadata, sleeper: ImmediateSleeper()
        )
        _ = try await resolver.resolve(TikTokEmbedParsingTests.sourceURL)

        let paths = await transport.requestedPaths
        XCTAssertEqual(paths, ["/embed/v2/6718335390845095173"])

        // TikTok serves a different page to an obvious bot.
        let requests = await transport.requests
        XCTAssertEqual(
            requests.first?.value(forHTTPHeaderField: "User-Agent"),
            TikTokMediaResolver.userAgent
        )
    }

    /// A URL that isn't a video and isn't a short link must fail before any request.
    func testNonVideoURLIsRejectedWithoutANetworkCall() async {
        let transport = StubTransport([])
        let resolver = TikTokMediaResolver(transport: transport, sleeper: ImmediateSleeper())
        do {
            _ = try await resolver.resolve(URL(string: "https://www.tiktok.com/@scout2015")!)
            XCTFail("expected notAMediaURL")
        } catch let error as ExtractionError {
            guard case .notAMediaURL = error else {
                return XCTFail("expected notAMediaURL, got \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
        let count = await transport.requestCount
        XCTAssertEqual(count, 0)
    }
}

final class MediaDownloaderTests: XCTestCase {
    /// A host TikTok actually serves from. Not incidental: the downloader refuses any
    /// host outside ``Platform/allowedMediaHosts``, so a made-up CDN name here would
    /// test the rejection path rather than the download.
    static let resolved = ResolvedMedia(
        sourceURL: TikTokEmbedParsingTests.sourceURL,
        platform: .tikTok,
        mediaURL: URL(string: "https://v16m.tiktokcdn-us.com/video.mp4")!,
        mimeType: "video/mp4",
        referer: URL(string: "https://www.tiktok.com/")
    )

    /// The media URL is read out of TikTok's own JSON blob, which makes it the one URL in
    /// the pipeline chosen by someone else. Anyone who can share a link can influence it.
    func testRefusesAHostThePlatformDoesNotServeFrom() async {
        let hostile = [
            // Somewhere else entirely.
            "https://evil.test/video.mp4",
            // Suffix-matched, not substring-matched: this must not pass for tiktokcdn.com.
            "https://tiktokcdn.com.evil.test/video.mp4",
            // The local network, which is the reason this check is not merely tidiness.
            "http://169.254.169.254/latest/meta-data/",
        ]
        for string in hostile {
            var media = Self.resolved
            media.mediaURL = URL(string: string)!
            let transport = StubTransport([.init(status: 200, body: Data(repeating: 1, count: 16))])
            let downloader = MediaDownloader(transport: transport, sleeper: ImmediateSleeper())

            do {
                _ = try await downloader.download(media)
                XCTFail("expected \(string) to be refused")
            } catch let error as ExtractionError {
                guard case .upstreamFailure(_, _, let message) = error else {
                    return XCTFail("expected upstreamFailure, got \(error)")
                }
                XCTAssertTrue(message.contains("refusing to fetch"), message)
            } catch {
                XCTFail("unexpected \(error)")
            }
            // The point of the check is that nothing was fetched at all.
            let count = await transport.requestCount
            XCTAssertEqual(count, 0, "\(string) should not have been requested")
        }
    }

    /// Instagram is still on the capture arm and has declared no CDN hosts, so the
    /// direct-fetch path must refuse it rather than fetch whatever it is handed. An
    /// empty allowlist means "nothing", never "anything".
    func testAPlatformWithNoDeclaredHostsCannotDownload() async {
        var media = Self.resolved
        media.platform = .instagram
        media.mediaURL = URL(string: "https://scontent.cdninstagram.com/v.mp4")!
        let transport = StubTransport([.init(status: 200, body: Data(repeating: 1, count: 16))])
        let downloader = MediaDownloader(transport: transport, sleeper: ImmediateSleeper())

        do {
            _ = try await downloader.download(media)
            XCTFail("expected the download to be refused")
        } catch let error as ExtractionError {
            guard case .upstreamFailure = error else {
                return XCTFail("expected upstreamFailure, got \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testAcceptsTikTokCDNSubdomains() {
        for host in ["v16m.tiktokcdn-us.com", "tiktokcdn.com", "p16.tiktokv.com", "x.muscdn.com"] {
            XCTAssertTrue(Platform.tikTok.allowsMediaHost(host), host)
        }
        for host in ["tiktokcdn.com.evil.test", "eviltiktokcdn.com", "", "cdn.example"] {
            XCTAssertFalse(Platform.tikTok.allowsMediaHost(host), host)
        }
    }

    func testDownloadsAndSendsReferer() async throws {
        let payload = Data(repeating: 3, count: 4096)
        let transport = StubTransport([
            .init(status: 200, body: payload, headers: ["Content-Type": "video/mp4"])
        ])
        let downloader = MediaDownloader(transport: transport, sleeper: ImmediateSleeper())

        let media = try await downloader.download(Self.resolved)
        XCTAssertEqual(media.byteCount, 4096)
        XCTAssertEqual(media.mimeType, "video/mp4")

        let requests = await transport.requests
        XCTAssertEqual(
            requests.first?.value(forHTTPHeaderField: "Referer"), "https://www.tiktok.com/"
        )
    }

    /// A share extension has a hard memory ceiling it cannot negotiate. Being killed
    /// mid-download looks to the user like the app doing nothing at all.
    func testRefusesAFileOverTheCap() async {
        let transport = StubTransport([
            .init(status: 200, body: Data(repeating: 0, count: 5000))
        ])
        let downloader = MediaDownloader(
            transport: transport, sleeper: ImmediateSleeper(), maxBytes: 4096
        )
        do {
            _ = try await downloader.download(Self.resolved)
            XCTFail("expected emptyResult")
        } catch let error as ExtractionError {
            guard case .emptyResult(let reason) = error else {
                return XCTFail("expected emptyResult, got \(error)")
            }
            XCTAssertTrue(reason.contains("limit"), reason)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testEmptyBodyIsAnError() async {
        let transport = StubTransport([.init(status: 200, body: Data())])
        let downloader = MediaDownloader(transport: transport, sleeper: ImmediateSleeper())
        do {
            _ = try await downloader.download(Self.resolved)
            XCTFail("expected emptyResult")
        } catch let error as ExtractionError {
            guard case .emptyResult = error else {
                return XCTFail("expected emptyResult, got \(error)")
            }
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    /// A CDN that answers `application/octet-stream` tells us nothing; the resolver's
    /// type is better than that. One that names a type knows more than we do.
    func testPrefersAMeaningfulServerContentType() async throws {
        let cases: [(String?, String)] = [
            ("video/mp4; charset=utf-8", "video/mp4"),
            ("application/octet-stream", "video/mp4"),
            (nil, "video/mp4"),
            ("video/quicktime", "video/quicktime"),
        ]
        for (header, expected) in cases {
            let transport = StubTransport([
                .init(
                    status: 200,
                    body: Data(repeating: 1, count: 16),
                    headers: header.map { ["Content-Type": $0] } ?? [:]
                )
            ])
            let downloader = MediaDownloader(transport: transport, sleeper: ImmediateSleeper())
            let media = try await downloader.download(Self.resolved)
            XCTAssertEqual(media.mimeType, expected, "for header \(header ?? "nil")")
        }
    }
}
