// A runnable harness for the progress animation.
//
// `SeerUI` had no consumer. It compiled to nothing on Linux (`#if canImport(SwiftUI)`),
// nothing in the package imported it, and there is no app target in this repository — so
// its source had never been through a compiler, and the animation it describes had never
// been rendered. A syntax error in it would have surfaced for the first time in whoever
// next opened Xcode.
//
// This target closes that gap from both ends. It gives the SwiftUI a build target on
// Apple platforms, and it gives the animation something to animate: `ScriptedExtractor`
// walks the real stage sequence on a timer, so the whole thing runs with no Gemini key,
// no network and no share extension.
//
// Run it with `swift run SeerUIDemo` on macOS, or open Package.swift in Xcode and pick
// the SeerUIDemo scheme. On Linux it builds to the stub at the bottom of this file, so
// `swift build` and `swift test` keep working there.

#if canImport(SwiftUI)
import SwiftUI
import SeerCore
import SeerUI

@main
struct SeerUIDemoApp: App {
    var body: some Scene {
        WindowGroup("Seer — progress") {
            DemoScreen()
        }
        #if os(macOS)
        .defaultSize(width: 460, height: 720)
        #endif
    }
}

/// The links the demo offers, and what each one is there to show.
enum DemoLink: String, CaseIterable, Identifiable {
    /// Native ingestion: the short script — resolving, analysing, done.
    case youTube
    /// Direct fetch, with a clip large enough to need the Files API. The longest script,
    /// and the only one that exercises `uploading` — the stage that is inserted mid-run
    /// rather than laid out up front.
    case tikTok
    /// The failure path. Instagram is genuinely unavailable (see docs/SPIKE-instagram.md),
    /// so this is what a user actually gets, not an invented error.
    case unsupported

    var id: String { rawValue }

    var title: String {
        switch self {
        case .youTube: return "YouTube"
        case .tikTok: return "TikTok (large clip)"
        case .unsupported: return "Unsupported"
        }
    }

    var url: URL {
        switch self {
        case .youTube: return URL(string: "https://youtu.be/jNQXAC9IVRw")!
        case .tikTok: return URL(string: "https://www.tiktok.com/@scout2015/video/6718335390845095173")!
        case .unsupported: return URL(string: "https://www.instagram.com/reel/CxAmpleReel/")!
        }
    }
}

/// A pipeline of scripted extractors, routing by link exactly as the real one does.
enum DemoPipeline {
    static func make(pace: TimeInterval = 1) -> ExtractionPipeline {
        ExtractionPipeline(extractors: [
            ScriptedExtractor(
                platform: .youTube,
                beats: ScriptedExtractor.script(for: .youTube, pace: pace)
            ),
            ScriptedExtractor(
                platform: .tikTok,
                beats: ScriptedExtractor.script(for: .tikTok, pace: pace, includeUpload: true)
            ),
            ScriptedExtractor(
                platform: .instagram,
                beats: [ScriptedExtractor.Beat(.resolving, duration: 1.5 * pace)],
                outcome: .failure(
                    .captureUnavailable(
                        reason: "screen capture is unresolved — see docs/EXTRACTION_PIPELINE.md"
                    )
                )
            ),
        ])
    }
}

@MainActor
struct DemoScreen: View {
    @State private var model = AnalysisModel(pipeline: DemoPipeline.make())
    @State private var link: DemoLink = .tikTok
    @State private var run: Task<Void, Never>?

    private var isRunning: Bool { model.state == .running }

    var body: some View {
        VStack(spacing: 20) {
            Picker("Link", selection: $link) {
                ForEach(DemoLink.allCases) { option in
                    Text(option.title).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .disabled(isRunning)

            AnalysisProgressView(model: model)
                .frame(maxHeight: .infinity)

            HStack(spacing: 12) {
                Button(isRunning ? "Running…" : "Run") { start() }
                    .disabled(isRunning)
                    .keyboardShortcut(.defaultAction)

                // Cancellation matters here rather than being a nicety: the model bridges
                // progress through an `AsyncStream` consumer task, and abandoning a run
                // is the case where that plumbing has to unwind cleanly.
                Button("Cancel") { run?.cancel() }
                    .disabled(!isRunning)
            }

            // The same breakdown the animation shows, as text. This is what makes a slow
            // run diagnosable after the fact — in a bug report or a log.
            ScrollView {
                Text(model.timingReport)
                    .font(.caption.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(height: 120)
        }
        .padding(20)
    }

    private func start() {
        run?.cancel()
        // A fresh model per run: `analyse` is written to be called once, and reusing one
        // across runs would leave the previous run's finished steps on screen.
        model = AnalysisModel(pipeline: DemoPipeline.make())
        let target = link.url
        let started = model
        run = Task { await started.analyse(target) }
    }
}

#Preview("Running — TikTok") {
    let model = AnalysisModel(pipeline: DemoPipeline.make())
    AnalysisProgressView(model: model)
        .task { await model.analyse(DemoLink.tikTok.url) }
}

#Preview("Failed") {
    let model = AnalysisModel(pipeline: DemoPipeline.make(pace: 0))
    AnalysisProgressView(model: model)
        .task { await model.analyse(DemoLink.unsupported.url) }
}

#Preview("Full demo") {
    DemoScreen()
}

#else

/// SwiftUI does not exist on Linux, so there is nothing to show — but the target still
/// has to produce an executable for `swift build` to succeed on this platform.
@main
enum SeerUIDemoUnavailable {
    static func main() {
        print(
            """
            SeerUIDemo needs SwiftUI, which is only available on Apple platforms.
            Build and run it on macOS: `swift run SeerUIDemo`, or open Package.swift in
            Xcode and choose the SeerUIDemo scheme.
            """
        )
    }
}

#endif
