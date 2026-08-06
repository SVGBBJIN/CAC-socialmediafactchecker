import Foundation

/// Swift port of `web/public/device.js`, and a deliberate exception to the "web fixes
/// stay in web" rule in CLAUDE.md: this is not a pipeline behaviour being kept in sync,
/// it is one layout *rule* that both surfaces implement, ported once because
/// `LibraryConceptView` is the Swift mirror of the same screen `web/public/index.html`
/// lays out. The comments in device.js are the reasoning; this file is the same decision
/// expressed in the signals a native app actually has.
///
/// The rule, unchanged from the web:
///
///   * **Width decides the layout.** Not the device model, not the idiom — how much room
///     there actually is right now. A Mac window dragged to 500pt wants the compact
///     layout for the same reason a browser window at 500px does, and an app in a Slide
///     Over pane on iPad is 320pt wide no matter how large the iPad is. This is why the
///     view below reads width from a `GeometryReader` rather than asking the environment
///     what kind of device it is.
///
///   * **The idiom may only narrow that verdict, never widen it.** An iPad in landscape
///     is 1194pt — desktop width by the numbers — but handing it the pointer-precision
///     layout would be wrong, because the input is still a finger. Same shape as the web
///     rule that keeps an iPad off the hover UI.
///
///   * **Touch is a separate axis from width.** It governs hit-target sizing and anything
///     that would otherwise depend on hover, and it does not change when the window is
///     resized. A trackpad-driven Mac at 400pt is compact *and* precise; an iPad at
///     1194pt is roomy *and* coarse. Collapsing these two into one "is mobile" flag is
///     the bug this split exists to prevent.
///
/// Kept free of SwiftUI (and of any `#if canImport(SwiftUI)` guard) on purpose, so it
/// compiles and is unit-testable on Linux where the rest of this module builds to
/// nothing. `SeerUITests` is what covers it in CI.

/// How much room there is, in the three bands the layout branches on.
public enum DeviceKind: String, Sendable, CaseIterable {
    /// One column; the library is a drawer rather than a permanent column.
    case phone
    /// Both panes, but sized for a finger.
    case tablet
    /// Both panes, pointer-precision controls.
    case desktop
}

/// What kind of hardware is reporting, independent of how wide its window happens to be.
/// The native analogue of the user-agent string in `device.js` — and like it, `unknown`
/// is a distinct case from "a desktop", so a caller can tell "no signal" from "a Mac".
public enum DeviceIdiom: String, Sendable {
    case phone
    case tablet
    case desktop
    case unknown

    /// The idiom of the machine this code is running on.
    ///
    /// Resolved at compile time by platform rather than at runtime by model: the
    /// package targets iOS and macOS, and that is exactly the distinction that matters
    /// here. Mac Catalyst counts as a desktop — it has a pointer and a resizable window,
    /// which is what the layout actually keys off.
    public static var current: DeviceIdiom {
        #if os(macOS) || targetEnvironment(macCatalyst)
        return .desktop
        #elseif os(iOS)
        // Deliberately *not* branching on `UIDevice.userInterfaceIdiom` to separate iPad
        // from iPhone. Width already does that job, and does it correctly in the cases
        // the idiom gets wrong — Split View, Slide Over, and Stage Manager all hand an
        // iPad app a window narrower than the iPad. Reporting `.tablet` here means only
        // "a touch device that may be given a wide window", which is precisely the
        // narrowing rule below.
        return .tablet
        #elseif os(tvOS) || os(watchOS)
        return .phone
        #else
        return .unknown
        #endif
    }

    /// Whether this idiom's primary input is a finger. The analogue of
    /// `(pointer: coarse)`, resolved from the platform for the same reason as above.
    public var isTouchByDefault: Bool {
        switch self {
        case .phone, .tablet: return true
        case .desktop, .unknown: return false
        }
    }
}

/// The current layout situation: how much room, and what the user is pointing with.
public struct DeviceProfile: Equatable, Sendable {
    public let kind: DeviceKind
    public let isTouch: Bool
    public let width: Double

    /// At or below this, one column and a drawer. Mirrors `PHONE_MAX_WIDTH` in device.js
    /// and the `max-width: 700px` query in index.html — three copies of one number,
    /// because neither CSS nor Swift can import the other's. Change all three together.
    public static let phoneMaxWidth: Double = 700

    /// Above this, the pointer-precision desktop layout. Mirrors `TABLET_MAX_WIDTH`.
    public static let tabletMaxWidth: Double = 1024

    public init(kind: DeviceKind, isTouch: Bool, width: Double) {
        self.kind = kind
        self.isTouch = isTouch
        self.width = width
    }

    /// Classifies a window of `width` points.
    ///
    /// - Parameters:
    ///   - width: The width available to the view, in points. Non-positive means
    ///     "unknown" — during the first layout pass, or off a `GeometryReader` that has
    ///     not been measured yet — and falls back to the idiom alone.
    ///   - idiom: What the hardware is. Defaults to the running platform.
    ///   - isTouch: Overrides the idiom's default input kind. Pass this when the app can
    ///     actually observe the pointer (a paired trackpad, an attached mouse); leave it
    ///     nil to take the platform's word for it.
    public static func classify(
        width: Double,
        idiom: DeviceIdiom = .current,
        isTouch: Bool? = nil
    ) -> DeviceProfile {
        let touch = isTouch ?? idiom.isTouchByDefault

        // No width yet: the idiom is all there is. `.unknown` falls back to desktop —
        // the layout the views are authored in, and so the one that degrades most
        // gracefully if the guess is wrong. Same fallback as device.js.
        guard width > 0 else {
            let fallback: DeviceKind
            switch idiom {
            case .phone: fallback = .phone
            case .tablet: fallback = .tablet
            case .desktop, .unknown: fallback = .desktop
            }
            return DeviceProfile(kind: fallback, isTouch: touch, width: 0)
        }

        var kind: DeviceKind =
            width <= phoneMaxWidth ? .phone
            : width <= tabletMaxWidth ? .tablet
            : .desktop

        // The narrowing rule. A phone stays a phone at any width it claims; a tablet
        // never reaches the desktop layout, however wide its window gets. Neither may
        // push a genuinely narrow window back *up* into a roomier layout.
        if idiom == .phone {
            kind = .phone
        } else if idiom == .tablet, kind == .desktop {
            kind = .tablet
        }

        return DeviceProfile(kind: kind, isTouch: touch, width: width)
    }

    /// True when the library has to be a drawer rather than a permanent column.
    public var usesDrawerNavigation: Bool { kind == .phone }

    /// Minimum hit target. 44pt is Apple's HIG floor and matches the 44px the web
    /// stylesheet uses under `[data-pointer="coarse"]`; a pointer can be trusted with
    /// the tighter control sizes the concept was drawn at.
    public var minimumHitTarget: Double { isTouch ? 44 : 28 }
}
