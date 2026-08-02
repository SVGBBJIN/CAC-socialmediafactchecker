import Foundation
import SeerCore

#if os(iOS) && canImport(WebKit)
import WebKit
import UIKit

/// Hosts a platform embed in a `WKWebView` and gets it playing.
///
/// The web view must be **on screen and unobscured** for the whole capture:
/// `RPScreenRecorder` records the display, so an off-screen or zero-alpha view records
/// as nothing. That constraint drives the API — callers hand over a container view
/// rather than getting a detached view back.
@MainActor
public final class WebViewEmbedRenderer: NSObject {
    private var webView: WKWebView?
    private var loadContinuation: CheckedContinuation<Void, Error>?

    public override init() { super.init() }

    /// Loads the embed into a web view added to `container` and waits for the platform's
    /// script to hydrate it into a player.
    ///
    /// Deliberately does **not** start playback — see ``startPlayback()``. The recorder
    /// has to be running before the first frame of audio, so the caller decides when
    /// playback begins.
    ///
    /// - Parameter settleTime: upper bound on the grace period after `didFinish` for
    ///   the platform's own script to hydrate the blockquote into a player. The load
    ///   callback fires when the *document* is done, which is well before the player
    ///   exists. Most embeds hydrate a `<video>` element well under this, so it is
    ///   polled for and this method returns as soon as one appears rather than always
    ///   waiting out the full grace period.
    public func present(
        _ embed: EmbeddedMedia,
        in container: UIView,
        settleTime: TimeInterval = 3.0,
        pollInterval: TimeInterval = 0.15
    ) async throws {
        let configuration = WKWebViewConfiguration()
        // Playback must be able to start without a tap: there is no user to tap.
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: container.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.isOpaque = true
        webView.scrollView.isScrollEnabled = false
        container.addSubview(webView)
        self.webView = webView

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.loadContinuation = continuation
            webView.loadHTMLString(
                embed.standaloneDocument(),
                // A real base URL matters: platform embed scripts check the origin, and
                // `about:blank` gets them refusing to hydrate.
                baseURL: URL(string: "https://\(embed.platform.embedOriginHost)/")
            )
        }

        await waitForPlayerElement(timeout: settleTime, pollInterval: pollInterval)
    }

    /// Polls for a `<video>` element to appear, latching as soon as one does.
    ///
    /// Falls back to waiting out the full `timeout` if none ever appears — absence
    /// isn't proof the player will never hydrate, just that it hasn't yet, so this
    /// never returns *later* than the old fixed sleep did, only ever the same or
    /// sooner.
    private func waitForPlayerElement(timeout: TimeInterval, pollInterval: TimeInterval) async {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if await hasVideoElement() { return }
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { return }
            try? await Task.sleep(nanoseconds: UInt64(min(pollInterval, remaining) * 1_000_000_000))
        }
    }

    private func hasVideoElement() async -> Bool {
        let script = "document.querySelectorAll('video').length > 0;"
        let result = try? await webView?.evaluateJavaScript(script)
        return (result as? Bool) ?? (result as? NSNumber)?.boolValue ?? false
    }

    /// Nudges any `<video>` on the page into playing.
    ///
    /// Platform players usually autoplay muted, then unmute on interaction — which is
    /// precisely the case we cannot rely on, since a muted player is a silent
    /// recording. So unmute explicitly and set volume before playing.
    ///
    /// Note that this returns as soon as `play()` has been *issued*: the promise it
    /// returns is deliberately not awaited, because a player that needs buffering can
    /// leave it pending for seconds. Use ``observePlayback(for:pollInterval:)`` to find
    /// out whether playback actually happened.
    public func startPlayback() async {
        let script = """
        (function () {
          var videos = document.querySelectorAll('video');
          var started = 0;
          for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            v.muted = false;
            v.volume = 1.0;
            var p = v.play();
            if (p && p.catch) { p.catch(function () {}); }
            started++;
          }
          return started;
        })();
        """
        _ = try? await webView?.evaluateJavaScript(script)
    }

    /// Whether any media element on the page is actually playing and audible.
    ///
    /// Worth checking before trusting a recording: an embed that silently failed to
    /// hydrate looks identical to one that played, from ReplayKit's side.
    public func isPlayingAudibly() async -> Bool {
        let script = """
        (function () {
          var videos = document.querySelectorAll('video');
          for (var i = 0; i < videos.length; i++) {
            var v = videos[i];
            if (!v.paused && !v.muted && v.volume > 0 && v.currentTime > 0) { return true; }
          }
          return false;
        })();
        """
        let result = try? await webView?.evaluateJavaScript(script)
        return (result as? Bool) ?? (result as? NSNumber)?.boolValue ?? false
    }

    /// Watches for audible playback across `duration`, returning true if it was ever
    /// observed. Doubles as the capture window — it spans the full `duration`.
    ///
    /// A single sample cannot answer this question, in either direction. Sample too
    /// early and `currentTime` is still 0 because `play()` has only just been issued;
    /// sample too late and a short clip has already run to its end and gone `paused`.
    /// Both read as "never played", and the caller uses that to decide whether a
    /// recording is trustworthy — so a false negative here throws away a perfectly good
    /// capture and, worse, looks exactly like the ReplayKit audio defect this path is
    /// trying to diagnose.
    ///
    /// So: poll, and latch on the first sighting.
    public func observePlayback(
        for duration: TimeInterval,
        pollInterval: TimeInterval = 0.5
    ) async -> Bool {
        var everPlayed = false
        let deadline = Date().addingTimeInterval(duration)

        while true {
            if !everPlayed {
                everPlayed = await isPlayingAudibly()
            }
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { break }
            try? await Task.sleep(nanoseconds: UInt64(min(pollInterval, remaining) * 1_000_000_000))
        }

        return everPlayed
    }

    public func tearDown() {
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
    }
}

extension WebViewEmbedRenderer: WKNavigationDelegate {
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadContinuation?.resume()
        loadContinuation = nil
    }

    public func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        loadContinuation?.resume(throwing: error)
        loadContinuation = nil
    }

    public func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        loadContinuation?.resume(throwing: error)
        loadContinuation = nil
    }
}

extension Platform {
    /// Origin the embed document is loaded against, so platform scripts hydrate.
    var embedOriginHost: String {
        switch self {
        case .tikTok: return "www.tiktok.com"
        case .instagram: return "www.instagram.com"
        case .youTube: return "www.youtube.com"
        case .unknown: return "localhost"
        }
    }
}

#endif
