import XCTest

@testable import SeerUI

/// Mirrors `web/test-device.js` case for case, so the two implementations of the same
/// layout rule can be compared by reading the two files side by side. Everything here is
/// pure Foundation, which is why it runs on the Linux CI box where the SwiftUI half of
/// `SeerUI` compiles to nothing.
final class DeviceProfileTests: XCTestCase {

    // MARK: - Width drives the layout

    func testWidthAlonePicksTheLayout() {
        XCTAssertEqual(DeviceProfile.classify(width: 390, idiom: .unknown).kind, .phone)
        XCTAssertEqual(DeviceProfile.classify(width: 834, idiom: .unknown).kind, .tablet)
        XCTAssertEqual(DeviceProfile.classify(width: 1440, idiom: .unknown).kind, .desktop)
    }

    func testBreakpointsAreInclusiveAtTheirUpperEdge() {
        XCTAssertEqual(DeviceProfile.classify(width: 700, idiom: .unknown).kind, .phone)
        XCTAssertEqual(DeviceProfile.classify(width: 701, idiom: .unknown).kind, .tablet)
        XCTAssertEqual(DeviceProfile.classify(width: 1024, idiom: .unknown).kind, .tablet)
        XCTAssertEqual(DeviceProfile.classify(width: 1025, idiom: .unknown).kind, .desktop)
    }

    func testNarrowedDesktopWindowGetsThePhoneLayout() {
        // The whole point of being width-led: a resized Mac window is compact, and the
        // idiom must not talk it back out of the compact layout.
        let profile = DeviceProfile.classify(width: 500, idiom: .desktop)
        XCTAssertEqual(profile.kind, .phone)
        XCTAssertFalse(profile.isTouch)
        XCTAssertTrue(profile.usesDrawerNavigation)
    }

    // MARK: - The idiom may only narrow

    func testTabletAtDesktopWidthStaysATablet() {
        // An iPad in landscape is 1194pt. Wide enough for both panes — never wide enough
        // to justify pointer-sized controls, because the input is still a finger.
        let profile = DeviceProfile.classify(width: 1194, idiom: .tablet)
        XCTAssertEqual(profile.kind, .tablet)
        XCTAssertTrue(profile.isTouch)
        XCTAssertEqual(profile.minimumHitTarget, 44)
    }

    func testTabletInASlideOverPaneNarrowsToPhone() {
        // Slide Over hands an iPad app ~320pt. The device did not change; the room did.
        let profile = DeviceProfile.classify(width: 320, idiom: .tablet)
        XCTAssertEqual(profile.kind, .phone)
        XCTAssertTrue(profile.usesDrawerNavigation)
    }

    func testPhoneStaysAPhoneAtAnyWidth() {
        XCTAssertEqual(DeviceProfile.classify(width: 980, idiom: .phone).kind, .phone)
        XCTAssertEqual(DeviceProfile.classify(width: 1440, idiom: .phone).kind, .phone)
    }

    func testPhoneLandscapeStillUsesTheDrawer() {
        // An iPhone 15 Pro Max in landscape is 932pt — tablet width by the numbers, and
        // still a phone-sized screen with a phone's vertical room.
        XCTAssertTrue(DeviceProfile.classify(width: 932, idiom: .phone).usesDrawerNavigation)
    }

    // MARK: - Touch is a separate axis

    func testTouchIsCapabilityLedNotWidthLed() {
        // Roomy but coarse.
        let tablet = DeviceProfile.classify(width: 1194, idiom: .tablet)
        XCTAssertEqual(tablet.kind, .tablet)
        XCTAssertTrue(tablet.isTouch)

        // Compact but precise.
        let narrowMac = DeviceProfile.classify(width: 420, idiom: .desktop)
        XCTAssertEqual(narrowMac.kind, .phone)
        XCTAssertFalse(narrowMac.isTouch)
        XCTAssertEqual(narrowMac.minimumHitTarget, 28)
    }

    func testExplicitTouchOverridesTheIdiomDefault() {
        // An iPad with a trackpad attached: still a tablet layout, now with a pointer.
        let withTrackpad = DeviceProfile.classify(width: 1194, idiom: .tablet, isTouch: false)
        XCTAssertEqual(withTrackpad.kind, .tablet)
        XCTAssertFalse(withTrackpad.isTouch)
        XCTAssertEqual(withTrackpad.minimumHitTarget, 28)

        // And the converse, for a touchscreen display driven by a desktop.
        let touchDesktop = DeviceProfile.classify(width: 1512, idiom: .desktop, isTouch: true)
        XCTAssertEqual(touchDesktop.kind, .desktop)
        XCTAssertTrue(touchDesktop.isTouch)
    }

    // MARK: - Degenerate input

    func testUnknownWidthFallsBackToTheIdiom() {
        // A GeometryReader reports 0 on the pass before it has been measured. Every
        // branch has to survive that without flashing the wrong layout.
        XCTAssertEqual(DeviceProfile.classify(width: 0, idiom: .phone).kind, .phone)
        XCTAssertEqual(DeviceProfile.classify(width: 0, idiom: .tablet).kind, .tablet)
        XCTAssertEqual(DeviceProfile.classify(width: 0, idiom: .desktop).kind, .desktop)
        XCTAssertEqual(DeviceProfile.classify(width: 0, idiom: .unknown).kind, .desktop)
    }

    func testNegativeWidthIsTreatedAsUnknown() {
        let profile = DeviceProfile.classify(width: -100, idiom: .unknown)
        XCTAssertEqual(profile.kind, .desktop)
        XCTAssertEqual(profile.width, 0)
    }

    // MARK: - Idiom defaults

    func testIdiomTouchDefaults() {
        XCTAssertTrue(DeviceIdiom.phone.isTouchByDefault)
        XCTAssertTrue(DeviceIdiom.tablet.isTouchByDefault)
        XCTAssertFalse(DeviceIdiom.desktop.isTouchByDefault)
        XCTAssertFalse(DeviceIdiom.unknown.isTouchByDefault)
    }

    func testCurrentIdiomResolvesForTheBuildPlatform() {
        // On Linux CI this is `.unknown`, which must still be a usable answer rather
        // than a crash or a nonsense layout.
        let profile = DeviceProfile.classify(width: 1440)
        XCTAssertTrue(DeviceKind.allCases.contains(profile.kind))
        #if os(macOS)
        XCTAssertEqual(DeviceIdiom.current, .desktop)
        XCTAssertEqual(profile.kind, .desktop)
        #elseif os(iOS) && !targetEnvironment(macCatalyst)
        XCTAssertEqual(DeviceIdiom.current, .tablet)
        XCTAssertEqual(profile.kind, .tablet, "a wide iPad window must not reach the desktop layout")
        #elseif os(Linux)
        XCTAssertEqual(DeviceIdiom.current, .unknown)
        XCTAssertEqual(profile.kind, .desktop)
        #endif
    }
}
