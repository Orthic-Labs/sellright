import SwiftUI
import XCTest
@testable import SellRightAdmin

/// The web generator (.audit/themes/check.cjs) verifies WCAG AA on every theme.
/// These re-verify the SWIFT transcription: a fat-fingered channel would
/// otherwise ship an illegible pairing that no compiler catches.
final class ThemeTests: XCTestCase {
    /// WCAG relative luminance + contrast ratio, same math as the web checker.
    private func luminance(_ color: Color) -> Double {
        let ui = UIColor(color)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.getRed(&r, green: &g, blue: &b, alpha: &a)
        func channel(_ c: CGFloat) -> Double {
            let v = Double(c)
            return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }

    private func contrast(_ a: Color, _ b: Color) -> Double {
        let l1 = luminance(a), l2 = luminance(b)
        let (hi, lo) = l1 > l2 ? (l1, l2) : (l2, l1)
        return (hi + 0.05) / (lo + 0.05)
    }

    func testBodyTextMeetsAAOnEveryThemeAndMode() {
        for name in ThemeName.allCases {
            for dark in [false, true] {
                let p = Theme.palette(name, dark: dark)
                let onBg = contrast(p.text, p.bg)
                let onSurface = contrast(p.text, p.surface)
                XCTAssertGreaterThanOrEqual(onBg, 4.5, "\(name.rawValue) dark=\(dark): text on bg = \(onBg)")
                XCTAssertGreaterThanOrEqual(onSurface, 4.5, "\(name.rawValue) dark=\(dark): text on surface = \(onSurface)")
            }
        }
    }

    func testAccentPairingsMeetAA() {
        for name in ThemeName.allCases {
            for dark in [false, true] {
                let p = Theme.palette(name, dark: dark)
                // Text placed ON the accent (buttons) — the pairing most likely
                // to break when an accent is hand-tweaked.
                let onAccent = contrast(p.onAccent, p.accent)
                XCTAssertGreaterThanOrEqual(onAccent, 4.5, "\(name.rawValue) dark=\(dark): on-accent = \(onAccent)")
                // The accent used as text/icons on the page background.
                let accentOnBg = contrast(p.accent, p.bg)
                XCTAssertGreaterThanOrEqual(accentOnBg, 3.0, "\(name.rawValue) dark=\(dark): accent on bg = \(accentOnBg)")
            }
        }
    }

    func testMutedTextStillReadable() {
        for name in ThemeName.allCases {
            for dark in [false, true] {
                let p = Theme.palette(name, dark: dark)
                // Muted text is real content (emails, SKUs) — AA for large text
                // at minimum; the web ramp targets the same.
                let muted = contrast(p.textMuted, p.bg)
                XCTAssertGreaterThanOrEqual(muted, 3.0, "\(name.rawValue) dark=\(dark): muted on bg = \(muted)")
            }
        }
    }

    func testDarkAndLightAreActuallyDifferent() {
        for name in ThemeName.allCases {
            let light = Theme.palette(name, dark: false)
            let dark = Theme.palette(name, dark: true)
            // Guards against a copy-paste that leaves a theme's dark rows equal
            // to its light rows — which compiles and looks "fine" in light mode.
            XCTAssertGreaterThan(luminance(light.bg), luminance(dark.bg), "\(name.rawValue): dark bg must be darker than light bg")
        }
    }

    // ThemeStore is @MainActor (it drives SwiftUI); the test has to be too.
    @MainActor
    func testModeResolution() {
        let store = ThemeStore()
        store.name = .graphite
        store.mode = .dark
        // An explicit mode must win over the system scheme.
        XCTAssertEqual(luminance(store.palette(for: .light).bg), luminance(Theme.palette(.graphite, dark: true).bg))
        store.mode = .system
        XCTAssertEqual(luminance(store.palette(for: .dark).bg), luminance(Theme.palette(.graphite, dark: true).bg))
        XCTAssertEqual(luminance(store.palette(for: .light).bg), luminance(Theme.palette(.graphite, dark: false).bg))
    }
}
