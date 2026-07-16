import SwiftUI

@main
struct SellRightAdminApp: App {
    // SwiftUI has no hook for the APNs device-token callbacks; the adaptor keeps
    // a minimal UIKit delegate purely to forward them into PushManager.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = AppSession()
    @State private var theme = ThemeStore()

    var body: some Scene {
        WindowGroup {
            ThemedRoot()
                .environment(session)
                .environment(theme)
                .task { await session.bootstrap() }
        }
    }
}

/// Resolves the palette against the system appearance and injects it, so every
/// view reads one `\.palette` rather than re-deriving light/dark itself.
private struct ThemedRoot: View {
    @Environment(ThemeStore.self) private var theme
    @Environment(\.colorScheme) private var systemScheme

    var body: some View {
        let palette = theme.palette(for: systemScheme)
        RootView()
            .environment(\.palette, palette)
            .tint(palette.accent)
            .background(palette.bg)
            // Forces light/dark when the operator has overridden System.
            .preferredColorScheme(theme.mode.colorScheme)
    }
}
