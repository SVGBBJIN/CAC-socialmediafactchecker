#if canImport(SwiftUI)
import SwiftUI
import SeerCore

/// What Seer shows while it is working on a link.
///
/// Three things at once, because they answer three different questions a waiting user
/// has:
///
/// - **A scanning animation** — "is this alive?" It sweeps continuously and is never
///   determinate, because none of the underlying work reports a percentage. A progress
///   bar filling at an invented rate would be a lie, and the moment it stalls at 90% it
///   is a worse lie than no bar at all.
/// - **A stage list** — "what is it doing?" Laid out in full from the start and filled
///   in as stages complete, so the shape of the wait is visible immediately.
/// - **Elapsed time, and an explanation once a stage overruns** — "should I be worried?"
///   A Gemini call on a long video can run past a minute; saying so is the difference
///   between slow and broken.
public struct AnalysisProgressView: View {
    private let model: AnalysisModel

    public init(model: AnalysisModel) {
        self.model = model
    }

    public var body: some View {
        // A 10 Hz tick drives the elapsed clock and the reassurance threshold. Cheap,
        // and it stops as soon as the view goes away.
        TimelineView(.periodic(from: .now, by: 0.1)) { context in
            let now = context.date
            VStack(spacing: 24) {
                ScanningFilmstrip(isActive: model.state == .running)

                VStack(spacing: 6) {
                    Text(model.label)
                        .font(.headline)
                        .multilineTextAlignment(.center)
                        .contentTransition(.opacity)

                    if model.state == .running {
                        Text(elapsedText(at: now))
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }

                if let explanation = model.explanation(at: now) {
                    Text(explanation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                StageList(steps: model.steps, currentStage: model.currentStage)
            }
            .padding(24)
            .animation(.easeInOut(duration: 0.25), value: model.currentStage)
            .animation(.easeInOut(duration: 0.25), value: model.explanation(at: now))
            // One spoken summary instead of a dozen chattering elements.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(model.label)
            .accessibilityValue(model.state == .running ? elapsedText(at: now) : "")
        }
    }

    private func elapsedText(at now: Date) -> String {
        String(format: "%.0fs elapsed", model.elapsed(at: now))
    }
}

// MARK: - The animation

/// A stylised video frame with a scan line sweeping across it.
///
/// Reads as "something is being examined" without implying a percentage. Honours Reduce
/// Motion: the sweep stops and the frame breathes instead, so the view still signals
/// life to someone who has asked the system for less movement.
struct ScanningFilmstrip: View {
    var isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweep: CGFloat = 0
    @State private var breathe = false

    private let size = CGSize(width: 132, height: 88)

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.quaternary)

            // Sprocket holes, to read as film rather than as a generic box.
            VStack {
                holes
                Spacer()
                holes
            }
            .padding(.vertical, 7)

            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(.tertiary, lineWidth: 1)

            if isActive && !reduceMotion {
                scanLine
            }
        }
        .frame(width: size.width, height: size.height)
        .scaleEffect(reduceMotion && isActive && breathe ? 1.04 : 1)
        .opacity(isActive ? 1 : 0.55)
        .onAppear(perform: startAnimating)
        .onChange(of: isActive) { _, _ in startAnimating() }
    }

    private var holes: some View {
        HStack(spacing: 9) {
            ForEach(0..<7, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(.background.opacity(0.7))
                    .frame(width: 7, height: 5)
            }
        }
    }

    private var scanLine: some View {
        GeometryReader { geometry in
            let travel = geometry.size.width
            LinearGradient(
                colors: [.clear, .accentColor.opacity(0.85), .clear],
                startPoint: .leading,
                endPoint: .trailing
            )
            .frame(width: 46)
            .offset(x: (travel + 46) * sweep - 46)
            .blur(radius: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .allowsHitTesting(false)
    }

    private func startAnimating() {
        guard isActive else { return }
        if reduceMotion {
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                breathe = true
            }
        } else {
            sweep = 0
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: false)) {
                sweep = 1
            }
        }
    }
}

// MARK: - Stages

struct StageList: View {
    var steps: [AnalysisModel.Step]
    var currentStage: ExtractionStage?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(steps) { step in
                StageRow(step: step, isCurrent: step.stage == currentStage)
            }
        }
        .frame(maxWidth: 280, alignment: .leading)
    }
}

struct StageRow: View {
    var step: AnalysisModel.Step
    var isCurrent: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 10) {
            marker
                .frame(width: 16, height: 16)

            Text(stageTitle)
                .font(.subheadline)
                .foregroundStyle(isCurrent ? .primary : .secondary)

            if let detail = step.detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            Spacer(minLength: 0)

            // Per-stage timings, which is what makes a slow run diagnosable rather than
            // just annoying.
            if let duration = step.duration {
                Text(String(format: "%.1fs", duration))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
        .opacity(step.hasStarted ? 1 : 0.4)
    }

    @ViewBuilder
    private var marker: some View {
        if step.isFinished {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.tint)
        } else if isCurrent {
            Circle()
                .fill(.tint)
                .scaleEffect(pulse && !reduceMotion ? 1 : 0.55)
                .opacity(pulse && !reduceMotion ? 0.35 : 1)
                .onAppear {
                    withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                        pulse = true
                    }
                }
        } else {
            Circle()
                .strokeBorder(.tertiary, lineWidth: 1.5)
        }
    }

    private var stageTitle: String {
        switch step.stage {
        case .resolving: return "Reading the link"
        case .fetchingMedia: return "Fetching the video"
        case .uploading: return "Uploading"
        case .analysing: return "Analyzing"
        case .done: return "Done"
        }
    }
}
#endif
