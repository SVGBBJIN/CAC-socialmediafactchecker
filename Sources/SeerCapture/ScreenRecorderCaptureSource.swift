import Foundation
import SeerCore

#if os(iOS) && canImport(ReplayKit)
import ReplayKit
import AVFoundation
import UIKit

/// `RPScreenRecorder` implementation of ``MediaCaptureSource``.
///
/// # Status: blocked, and deliberately so
///
/// ReplayKit's `.audioApp` stream frequently arrives **silent** when the sound is
/// produced by a `WKWebView`. The web view's media plays on its own `AVAudioSession`,
/// and ReplayKit's app-audio tap does not reliably pick it up. The recording succeeds,
/// the file is well-formed, and it contains nothing.
///
/// This implementation therefore does one thing the naive version does not: it
/// **measures** the audio it captured and reports ``CapturedMedia/containsAudio``
/// honestly, rather than assuming a successful `stopCapture` means a usable recording.
/// A silent capture fails fast with a clear error instead of producing an empty
/// transcript that downstream reads as "this video makes no claims".
///
/// Run ``AudioCaptureDiagnostic`` on a device before building anything on top of this.
/// Until it reports audible frames, `MockCaptureSource` is the only source that should
/// be wired into a working pipeline.
public final class ScreenRecorderCaptureSource: NSObject, MediaCaptureSource {
    private let hostContainer: @Sendable @MainActor () -> UIView?
    private let silenceThreshold: Float

    /// - Parameters:
    ///   - hostContainer: supplies the on-screen view to render the embed into. The
    ///     view must be visible for the duration — ReplayKit records the display.
    ///   - silenceThreshold: peak linear amplitude below which a recording counts as
    ///     silent. 0.005 (≈ -46 dBFS) sits above dithering noise and below speech.
    public init(
        hostContainer: @escaping @Sendable @MainActor () -> UIView?,
        silenceThreshold: Float = 0.005
    ) {
        self.hostContainer = hostContainer
        self.silenceThreshold = silenceThreshold
        super.init()
    }

    public func capture(embed: EmbeddedMedia, duration: TimeInterval) async throws -> CapturedMedia {
        let recorder = RPScreenRecorder.shared()
        guard recorder.isAvailable else {
            throw ExtractionError.captureUnavailable(reason: "screen recording is not available on this device")
        }
        guard !recorder.isRecording else {
            throw ExtractionError.captureUnavailable(reason: "a recording is already in progress")
        }
        // Microphone off: we want the app's audio, and enabling the mic both prompts
        // the user and risks recording the room instead of the video.
        recorder.isMicrophoneEnabled = false

        let renderer = await WebViewEmbedRenderer()
        defer { Task { @MainActor in renderer.tearDown() } }

        guard let container = await hostContainer() else {
            throw ExtractionError.captureUnavailable(reason: "no on-screen container to render the embed into")
        }
        try await renderer.present(embed, in: container)

        let writer = try AudioSampleWriter(silenceThreshold: silenceThreshold)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            recorder.startCapture { buffer, bufferType, error in
                guard error == nil else { return }
                // Only app audio is retained; video frames are dropped. Transcription
                // needs sound, and holding video would mean a multi-hundred-megabyte
                // buffer inside a share extension's memory limit.
                if bufferType == .audioApp {
                    writer.append(buffer)
                }
            } completionHandler: { error in
                if let error {
                    continuation.resume(throwing: Self.mapStartError(error))
                } else {
                    continuation.resume()
                }
            }
        }

        // Confirm the embed is genuinely playing rather than sitting on a poster frame.
        let playing = await renderer.isPlayingAudibly()

        try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            recorder.stopCapture { error in
                if let error {
                    continuation.resume(throwing: ExtractionError.upstreamFailure(
                        service: "ReplayKit", status: nil, message: error.localizedDescription
                    ))
                } else {
                    continuation.resume()
                }
            }
        }

        let result = try writer.finish()

        return CapturedMedia(
            data: result.data,
            mimeType: "audio/m4a",
            duration: result.duration,
            frames: [],
            // Both signals must agree. `didCaptureAudibleAudio` is the authoritative
            // one; `playing` catches the case where the embed never hydrated at all.
            containsAudio: result.didCaptureAudibleAudio && playing
        )
    }

    static func mapStartError(_ error: Error) -> Error {
        let nsError = error as NSError
        guard nsError.domain == RPRecordingErrorDomain else {
            return ExtractionError.upstreamFailure(
                service: "ReplayKit", status: nil, message: error.localizedDescription
            )
        }
        switch RPRecordingErrorCode(rawValue: nsError.code) {
        case .userDeclined:
            return ExtractionError.permissionDenied("screen recording")
        case .insufficientStorage:
            return ExtractionError.captureUnavailable(reason: "not enough storage to record")
        case .attemptToStartInRecordingState:
            return ExtractionError.captureUnavailable(reason: "a recording is already in progress")
        default:
            return ExtractionError.upstreamFailure(
                service: "ReplayKit", status: nsError.code, message: error.localizedDescription
            )
        }
    }
}

/// Writes `.audioApp` sample buffers to an m4a file, measuring peak amplitude as it goes.
///
/// The measurement is the point: it is what distinguishes "ReplayKit gave us silence"
/// from "the recording worked", and those two are indistinguishable from the file's
/// size, duration or format.
final class AudioSampleWriter: @unchecked Sendable {
    private let outputURL: URL
    private let writer: AVAssetWriter
    private var input: AVAssetWriterInput?
    private let queue = DispatchQueue(label: "app.seer.audio-writer")

    private var started = false
    private var peakAmplitude: Float = 0
    private var sampleCount: Int = 0
    private var firstTimestamp: CMTime?
    private var lastTimestamp: CMTime?

    private let silenceThreshold: Float

    struct Output {
        var data: Data
        var duration: TimeInterval
        var didCaptureAudibleAudio: Bool
        var peakAmplitude: Float
    }

    init(silenceThreshold: Float) throws {
        self.silenceThreshold = silenceThreshold
        self.outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("seer-capture-\(UUID().uuidString).m4a")
        self.writer = try AVAssetWriter(outputURL: outputURL, fileType: .m4a)
    }

    func append(_ buffer: CMSampleBuffer) {
        queue.sync {
            guard CMSampleBufferDataIsReady(buffer) else { return }

            if !started {
                guard let formatDescription = CMSampleBufferGetFormatDescription(buffer),
                      let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
                else { return }

                let settings: [String: Any] = [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: streamDescription.pointee.mSampleRate,
                    AVNumberOfChannelsKey: Int(streamDescription.pointee.mChannelsPerFrame),
                    AVEncoderBitRateKey: 64_000,
                ]
                let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
                input.expectsMediaDataInRealTime = true
                guard writer.canAdd(input) else { return }
                writer.add(input)
                self.input = input
                writer.startWriting()
                writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(buffer))
                started = true
            }

            measurePeak(in: buffer)

            let timestamp = CMSampleBufferGetPresentationTimeStamp(buffer)
            if firstTimestamp == nil { firstTimestamp = timestamp }
            lastTimestamp = timestamp

            if let input, input.isReadyForMoreMediaData {
                input.append(buffer)
                sampleCount += 1
            }
        }
    }

    /// Peak linear amplitude across the buffer, normalised to 0...1.
    ///
    /// Peak rather than RMS: over a short window, quiet-but-present speech pulls RMS
    /// down near the noise floor, and treating real audio as silence is the more
    /// expensive mistake here — it discards a usable recording.
    private func measurePeak(in buffer: CMSampleBuffer) {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(buffer) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer
        ) == kCMBlockBufferNoErr, let pointer else { return }

        guard let formatDescription = CMSampleBufferGetFormatDescription(buffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else { return }

        let isFloat = asbd.pointee.mFormatFlags & kAudioFormatFlagIsFloat != 0
        if isFloat {
            let count = length / MemoryLayout<Float>.size
            pointer.withMemoryRebound(to: Float.self, capacity: count) { samples in
                for index in 0..<count {
                    peakAmplitude = max(peakAmplitude, abs(samples[index]))
                }
            }
        } else {
            // ReplayKit's app audio is 16-bit signed integer PCM in practice.
            let count = length / MemoryLayout<Int16>.size
            pointer.withMemoryRebound(to: Int16.self, capacity: count) { samples in
                for index in 0..<count {
                    let normalised = abs(Float(samples[index])) / Float(Int16.max)
                    peakAmplitude = max(peakAmplitude, normalised)
                }
            }
        }
    }

    func finish() throws -> Output {
        try queue.sync {
            guard started, let input else {
                // No audio buffers arrived at all — the clearest form of the failure.
                return Output(data: Data(), duration: 0, didCaptureAudibleAudio: false, peakAmplitude: 0)
            }
            input.markAsFinished()

            let semaphore = DispatchSemaphore(value: 0)
            writer.finishWriting { semaphore.signal() }
            semaphore.wait()

            guard writer.status == .completed else {
                throw ExtractionError.upstreamFailure(
                    service: "AVAssetWriter",
                    status: nil,
                    message: writer.error?.localizedDescription ?? "writing failed"
                )
            }

            let data = try Data(contentsOf: outputURL)
            try? FileManager.default.removeItem(at: outputURL)

            let duration: TimeInterval
            if let first = firstTimestamp, let last = lastTimestamp {
                duration = CMTimeGetSeconds(CMTimeSubtract(last, first))
            } else {
                duration = 0
            }

            return Output(
                data: data,
                duration: duration,
                didCaptureAudibleAudio: peakAmplitude > silenceThreshold,
                peakAmplitude: peakAmplitude
            )
        }
    }
}

#endif
