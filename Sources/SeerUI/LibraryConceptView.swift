#if canImport(SwiftUI)
import SwiftUI

/// A desktop "library" screen — paste a link, watch each claim resolve to a verdict,
/// browse past checks in a sidebar.
///
/// This is a **visual concept**, not a consumer of the real pipeline: `SeerCore` has no
/// verdict or source-matching model yet (`ClaimContext` stops at `candidateClaims`), so
/// everything below the entry bar is scripted mock data. It exists to let the design be
/// looked at and interacted with before that model gets built, the same way
/// `SeerUIDemoApp` gave `AnalysisProgressView` a consumer before there was a real app
/// target. Do not wire this to a network call — build the verdict model first.
public struct LibraryConceptView: View {
    @State private var library: [ConceptLibraryItem] = .sample
    @State private var selection: ConceptLibraryItem.ID?
    @State private var runID = 0

    public init() {}

    public var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 250)
                .background(.thinMaterial)

            Divider()

            VStack(spacing: 0) {
                entryBar
                Divider()
                ScrollView {
                    HStack(alignment: .top, spacing: 20) {
                        videoPane
                            .frame(width: 240)

                        VStack(spacing: 16) {
                            ForEach(ConceptClaim.sample) { claim in
                                ClaimCardView(claim: claim, runID: runID)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(20)
                }
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        .onAppear { selection = library.first?.id }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Library", systemImage: "eye")
                .font(.system(.headline, design: .serif))
                .padding(.horizontal, 4)

            List(library, selection: $selection) { item in
                LibraryRow(item: item)
                    .tag(item.id)
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
        }
        .padding(.top, 18)
    }

    private var entryBar: some View {
        HStack(spacing: 8) {
            TextField("Paste a TikTok, YouTube, or Instagram link…", text: .constant(
                "tiktok.com/@wellness.tips/video/7412…"
            ))
            .textFieldStyle(.plain)
            .padding(11)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9, style: .continuous))

            // Re-runs the mock stage sequence, matching the concept's "Check" button.
            Button("Check") { runID += 1 }
                .buttonStyle(.borderedProminent)
                .tint(.teal)
        }
        .padding(18)
    }

    private var videoPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.18, green: 0.21, blue: 0.27), Color(red: 0.08, green: 0.09, blue: 0.11)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .aspectRatio(9.0 / 16.0, contentMode: .fit)
                .overlay(Image(systemName: "play.fill").foregroundStyle(.white.opacity(0.55)))

            Label("TikTok · 0:58", systemImage: "play.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(.regularMaterial, in: Capsule())

            Text("\u{201c}3 things your liver needs you to know\u{201d}")
                .font(.system(.subheadline, design: .serif))

            Link("Open original ↗", destination: URL(string: "https://tiktok.com")!)
                .font(.caption)
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct LibraryRow: View {
    var item: ConceptLibraryItem

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.16, green: 0.19, blue: 0.25), Color(red: 0.10, green: 0.12, blue: 0.15)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 32, height: 32)

            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.caption)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle().fill(item.verdict.color).frame(width: 6, height: 6)
                    Text("\(item.platform) · \(item.verdict.label)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Claim card

/// One claim card: an iris spinner while the mock check "runs", then the verdict,
/// authenticity note and source list — mirroring the concept's stamp-in reveal.
private struct ClaimCardView: View {
    var claim: ConceptClaim
    var runID: Int

    @State private var runner = ConceptClaimRunner()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch runner.phase {
            case .running(let status, let counter):
                VStack(spacing: 10) {
                    IrisSpinner(resolved: false)
                        .frame(width: 40, height: 40)
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .contentTransition(.opacity)
                    if let counter {
                        Text(counter)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.teal)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 18)

            case .resolved:
                Text("CLAIM AT \(claim.timeLabel)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)

                Text(claim.text)
                    .font(.system(.body, design: .serif))
                    .transition(.opacity.combined(with: .move(edge: .top)))

                HStack(spacing: 8) {
                    Label(claim.verdict.label, systemImage: claim.verdict.systemImage)
                        .font(.caption.bold())
                        .padding(.horizontal, 11)
                        .padding(.vertical, 6)
                        .background(claim.verdict.color.opacity(0.15), in: Capsule())
                        .foregroundStyle(claim.verdict.color)
                        .overlay(Capsule().strokeBorder(claim.verdict.color.opacity(0.35)))

                    Label("Authenticity: no signs of AI generation", systemImage: "checkmark.seal")
                        .font(.caption.bold())
                        .padding(.horizontal, 11)
                        .padding(.vertical, 6)
                        .background(.secondary.opacity(0.12), in: Capsule())
                        .foregroundStyle(.secondary)
                }
                .transition(.scale(scale: 0.5).combined(with: .opacity))

                VStack(alignment: .leading, spacing: 6) {
                    Text(claim.sourcesLabel.uppercased())
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                    ForEach(claim.sources) { source in
                        HStack {
                            Text(source.label)
                            Spacer()
                            Text(source.match)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        .font(.caption)
                    }
                }
                .padding(.top, 10)
                .overlay(alignment: .top) { Divider() }
                .transition(.opacity)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .animation(.easeInOut(duration: 0.3), value: runner.phase)
        .task(id: runID) { await runner.run(claim: claim) }
    }
}

/// Steps a claim card through the same beats as the HTML concept's `stagesFor`, on a
/// timer — there is no real cross-check to run yet.
@MainActor
@Observable
private final class ConceptClaimRunner {
    enum Phase: Equatable {
        case running(status: String, counter: String?)
        case resolved
    }

    private(set) var phase: Phase = .running(status: "Pulling transcript…", counter: nil)

    func run(claim: ConceptClaim) async {
        phase = .running(status: "Pulling transcript…", counter: nil)
        let stages: [(String, Double)] = [
            ("Pulling transcript…", 1.1),
            ("Extracting claims…", 0.9),
            ("Cross-checking sources…", claim.sources.isEmpty ? 0.3 : 0.6 * Double(claim.sources.count)),
            ("Checking authenticity…", 0.9),
        ]
        for (text, seconds) in stages {
            if text == "Cross-checking sources…" && !claim.sources.isEmpty {
                for i in 1...claim.sources.count {
                    phase = .running(status: text, counter: "Source \(i) of \(claim.sources.count)")
                    try? await Task.sleep(for: .seconds(seconds / Double(claim.sources.count)))
                }
            } else {
                phase = .running(status: text, counter: nil)
                try? await Task.sleep(for: .seconds(seconds))
            }
            if Task.isCancelled { return }
        }
        withAnimation { phase = .resolved }
    }
}

/// Six radial blades that breathe while running and settle into a checkmark once
/// `resolved` — the SwiftUI read of the concept's CSS `blade-breathe` iris.
private struct IrisSpinner: View {
    var resolved: Bool

    var body: some View {
        TimelineView(.animation) { context in
            Canvas { canvasContext, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let t = context.date.timeIntervalSinceReferenceDate

                for i in 0..<6 {
                    let angle = Angle.degrees(Double(i) * 60)
                    let phase = t * 2.4 - Double(i) * 0.43 * (2.4)
                    let breathe = resolved ? 0.35 : 0.55 + 0.4 * (0.5 + 0.5 * sin(phase))

                    var blade = canvasContext
                    blade.translateBy(x: center.x, y: center.y)
                    blade.rotate(by: angle)
                    blade.opacity = breathe

                    let rect = CGRect(x: -3, y: -size.height * 0.42, width: 6, height: size.height * 0.34)
                    blade.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(.teal))
                }
            }

            .overlay {
                if resolved {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.green)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.25), value: resolved)
        }
    }
}

// MARK: - Mock data

private enum ConceptVerdict {
    case contradicted, disputed, corroborated, insufficient

    var label: String {
        switch self {
        case .contradicted: return "Contradicted"
        case .disputed: return "Disputed"
        case .corroborated: return "Corroborated"
        case .insufficient: return "Insufficient evidence"
        }
    }

    var color: Color {
        switch self {
        case .contradicted: return .red
        case .disputed: return .yellow
        case .corroborated: return .green
        case .insufficient: return .secondary
        }
    }

    var systemImage: String {
        switch self {
        case .contradicted: return "arrow.uturn.left"
        case .disputed: return "questionmark.circle"
        case .corroborated: return "checkmark.circle"
        case .insufficient: return "questionmark.circle"
        }
    }
}

private struct ConceptSource: Identifiable {
    let id = UUID()
    var label: String
    var match: String
}

private struct ConceptClaim: Identifiable {
    let id = UUID()
    var timeLabel: String
    var text: String
    var verdict: ConceptVerdict
    var sources: [ConceptSource]
    var sourcesLabel: String

    static let sample: [ConceptClaim] = [
        ConceptClaim(
            timeLabel: "0:12",
            text: "\u{201c}Drinking celery juice every morning flushes toxins out of your liver.\u{201d}",
            verdict: .contradicted,
            sources: [
                ConceptSource(label: "Mayo Clinic — liver function", match: "match"),
                ConceptSource(label: "Cleveland Clinic — detox claims", match: "match"),
                ConceptSource(label: "NIH — hepatic physiology", match: "match"),
            ],
            sourcesLabel: "Checked against 3 sources"
        ),
        ConceptClaim(
            timeLabel: "0:31",
            text: "\u{201c}Celery juice absorbs into your body better than eating whole vegetables.\u{201d}",
            verdict: .insufficient,
            sources: [
                ConceptSource(label: "USDA FoodData Central", match: "no match"),
                ConceptSource(label: "Harvard T.H. Chan — nutrition", match: "partial"),
            ],
            sourcesLabel: "Checked against 2 sources — below 3-source threshold"
        ),
    ]
}

private struct ConceptLibraryItem: Identifiable {
    let id = UUID()
    var title: String
    var platform: String
    var verdict: ConceptVerdict

    static let sample: [ConceptLibraryItem] = [
        ConceptLibraryItem(title: "Celery juice liver detox", platform: "TikTok", verdict: .contradicted),
        ConceptLibraryItem(title: "Cold plunges \"boost\" metabolism 300%", platform: "YouTube", verdict: .disputed),
        ConceptLibraryItem(title: "7-day jawline fix routine", platform: "Instagram", verdict: .insufficient),
        ConceptLibraryItem(title: "Handwashing cuts cold transmission", platform: "YouTube", verdict: .corroborated),
    ]
}

#Preview("Library concept") {
    LibraryConceptView()
        .preferredColorScheme(.dark)
}
#endif
