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
        VStack(spacing: 24) {
            ScanningFilmstrip(isActive: model.state.isActive)

            // Only the clock and the reassurance text are time-driven, so only they sit
            // inside the timeline. Wrapping the whole view in it — which is what this
            // did — re-evaluated `ScanningFilmstrip`, `StageList` and every `StageRow`
            // ten times a second for the entire life of the screen, including after the
            // run had finished or failed and nothing could change again. The stage rows
            // redraw when `model` publishes, which is the only time they have news.
            TimeDrivenStatus(model: model)

            StageList(steps: model.steps, currentStage: model.currentStage)
        }
        .padding(24)
        .animation(.easeInOut(duration: 0.25), value: model.currentStage)
    }
}

/// The two elements that genuinely change with the clock rather than with the model.
///
/// The schedule is paused outside a running state: an idle, finished, cancelled or failed
/// screen has no elapsed time to advance and no threshold left to cross, so ticking it is
/// pure battery. `.animation(minimumInterval:paused:)` rather than `.periodic` because it
/// keeps the timeline in place — no view identity change when a run starts — while
/// emitting nothing until there is something to say.
private struct TimeDrivenStatus: View {
    let model: AnalysisModel

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: !model.state.isActive)) { context in
            // Computed once per tick and shared. `explanation(at:)` walks `steps` and
            // builds an `ExtractionProgress` on every call, and it used to be called
            // twice per frame — once for the `if let`, once again for the `.animation`
            // value — so half that work was being thrown away.
            let explanation = model.explanation(at: context.date)
            let elapsed = String(format: "%.0fs elapsed", model.elapsed(at: context.date))

            VStack(spacing: 6) {
                Text(model.label)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .contentTransition(.opacity)

                if model.state.isActive {
                    Text(elapsed)
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                if let explanation {
                    Text(explanation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .animation(.easeInOut(duration: 0.25), value: explanation)
            // One spoken summary instead of a dozen chattering elements.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(model.label)
            .accessibilityValue(model.state.isActive ? elapsed : "")
        }
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
        // A `repeatForever` animation runs until something replaces it — going inactive
        // only stops the sweep being *drawn*, because `scanLine` leaves the hierarchy.
        // The animation itself keeps driving `sweep` (and, under Reduce Motion, `breathe`,
        // which stays attached to a `scaleEffect` that is still in the tree) for as long
        // as the screen is up. Replacing it with a non-repeating animation back to rest
        // is what actually ends it.
        guard isActive else {
            withAnimation(.easeOut(duration: 0.2)) {
                sweep = 0
                breathe = false
            }
            return
        }
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
