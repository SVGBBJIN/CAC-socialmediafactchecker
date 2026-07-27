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

    /// Loads the embed into a web view added to `container`, and resolves once the
    /// page reports its player is ready.
    ///
    /// - Parameter settleTime: grace period after `didFinish` for the platform's own
    ///   script to hydrate the blockquote into a player and start playback. The load
    ///   callback fires when the *document* is done, which is well before the video is.
    public func present(
        _ embed: EmbeddedMedia,
        in container: UIView,
        settleTime: TimeInterval = 3.0
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

        try await Task.sleep(nanoseconds: UInt64(settleTime * 1_000_000_000))
        try await startPlaybackIfNeeded()
    }

    /// Nudges any `<video>` on the page into playing.
    ///
    /// Platform players usually autoplay muted, then unmute on interaction — which is
    /// precisely the case we cannot rely on, since a muted player is a silent
    /// recording. So unmute explicitly and set volume before playing.
    private func startPlaybackIfNeeded() async throws {
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
