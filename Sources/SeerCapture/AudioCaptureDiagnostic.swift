import Foundation
import SeerCore

#if os(iOS) && canImport(ReplayKit)
import ReplayKit
import AVFoundation
import UIKit

/// Answers one question on a real device: **does `RPScreenRecorder` capture audible
/// audio from a `WKWebView`?**
///
/// This is the blocker for the whole capture path. Run it before writing or trusting
/// any TikTok/Instagram logic — the result decides whether that path is viable at all.
/// It deliberately does no transcription and makes no network calls beyond fetching the
/// embed: it isolates the one uncertain step.
///
/// Usage from a debug screen:
/// ```swift
/// let report = try await AudioCaptureDiagnostic(hostContainer: { self.view })
///     .run(on: URL(string: "https://www.tiktok.com/@user/video/123")!)
/// print(report.summary)
/// ```
@MainActor
public struct AudioCaptureDiagnostic {
    private let hostContainer: @Sendable @MainActor () -> UIView?
    private let resolver: any EmbedResolver

    public init(
        hostContainer: @escaping @Sendable @MainActor () -> UIView?,
        resolver: any EmbedResolver = OEmbedResolver.tikTok()
    ) {
        self.hostContainer = hostContainer
        self.resolver = resolver
    }

    public struct Report: Sendable {
        public var embedResolved: Bool
        public var embedRendered: Bool
        /// The page reported a `<video>` playing, unmuted, past 0s.
        public var playerReportedPlaying: Bool
        /// ReplayKit delivered at least one `.audioApp` buffer.
        public var audioBuffersReceived: Int
        /// Loudest sample seen, 0...1.
        public var peakAmplitude: Float
        public var audioAudible: Bool
        public var failure: String?

        /// One-line verdict, and — when it fails — which layer failed.
        public var summary: String {
            if let failure { return "FAILED: \(failure)" }
            if !embedResolved { return "FAILED: oEmbed did not return embed HTML" }
            if !embedRendered { return "FAILED: embed HTML did not render in WKWebView" }
            if !playerReportedPlaying {
                return """
                FAILED: the embed rendered but never started playing. This is a WKWebView \
                autoplay problem, not an audio-session one — fix it before drawing any \
                conclusion about ReplayKit.
                """
            }
            if audioBuffersReceived == 0 {
                return """
                BLOCKED: the video played but ReplayKit delivered zero .audioApp buffers. \
                This is the known WKWebView audio-session isolation issue. The capture \
                path is not viable as designed.
                """
            }
            if !audioAudible {
                return """
                BLOCKED: ReplayKit delivered \(audioBuffersReceived) audio buffers but all \
                were silent (peak \(String(format: "%.5f", peakAmplitude))). The web view's \
                audio is not reaching the app-audio tap. The capture path is not viable \
                as designed.
                """
            }
            return """
            PASS: captured \(audioBuffersReceived) audio buffers, peak \
            \(String(format: "%.3f", peakAmplitude)). The capture path is viable — wire \
            ScreenRecorderCaptureSource in place of MockCaptureSource.
            """
        }
    }

    /// Renders the embed, records for `duration`, and reports what arrived.
    public func run(on url: URL, duration: TimeInterval = 12) async throws -> Report {
        var report = Report(
            embedResolved: false,
            embedRendered: false,
            playerReportedPlaying: false,
            audioBuffersReceived: 0,
            peakAmplitude: 0,
            audioAudible: false,
            failure: nil
        )

        let embed: EmbeddedMedia
        do {
            embed = try await resolver.resolve(url)
            report.embedResolved = true
        } catch {
            report.failure = "oEmbed: \(error.localizedDescription)"
            return report
        }

        guard let container = hostContainer() else {
            report.failure = "no on-screen container supplied"
            return report
        }

        let renderer = WebViewEmbedRenderer()
        defer { renderer.tearDown() }
        do {
            try await renderer.present(embed, in: container)
            report.embedRendered = true
        } catch {
            report.failure = "WKWebView: \(error.localizedDescription)"
            return report
        }

        report.playerReportedPlaying = await renderer.isPlayingAudibly()

        let recorder = RPScreenRecorder.shared()
        guard recorder.isAvailable, !recorder.isRecording else {
            report.failure = "RPScreenRecorder unavailable or already recording"
            return report
        }
        recorder.isMicrophoneEnabled = false

        let probe = AudioProbe()
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                recorder.startCapture { buffer, bufferType, _ in
                    if bufferType == .audioApp { probe.observe(buffer) }
                } completionHandler: { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
        } catch {
            report.failure = "startCapture: \(error.localizedDescription)"
            return report
        }

        try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            recorder.stopCapture { _ in continuation.resume() }
        }

        let observed = probe.snapshot()
        report.audioBuffersReceived = observed.bufferCount
        report.peakAmplitude = observed.peak
        report.audioAudible = observed.peak > 0.005
        return report
    }
}

/// Counts `.audioApp` buffers and tracks their peak amplitude. Measurement only —
/// nothing is written to disk.
final class AudioProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var bufferCount = 0
    private var peak: Float = 0

    func observe(_ buffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(buffer),
              let blockBuffer = CMSampleBufferGetDataBuffer(buffer),
              let formatDescription = CMSampleBufferGetFormatDescription(buffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else { return }

        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer
        ) == kCMBlockBufferNoErr, let pointer else { return }

        var localPeak: Float = 0
        if asbd.pointee.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
            let count = length / MemoryLayout<Float>.size
            pointer.withMemoryRebound(to: Float.self, capacity: count) { samples in
                for index in 0..<count { localPeak = max(localPeak, abs(samples[index])) }
            }
        } else {
            let count = length / MemoryLayout<Int16>.size
            pointer.withMemoryRebound(to: Int16.self, capacity: count) { samples in
                for index in 0..<count {
                    localPeak = max(localPeak, abs(Float(samples[index])) / Float(Int16.max))
                }
            }
        }

        lock.lock()
        bufferCount += 1
        peak = max(peak, localPeak)
        lock.unlock()
    }

    func snapshot() -> (bufferCount: Int, peak: Float) {
        lock.lock(); defer { lock.unlock() }
        return (bufferCount, peak)
    }
}

#endif
