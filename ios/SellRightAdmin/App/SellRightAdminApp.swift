import SwiftUI

@main
struct SellRightAdminApp: App {
    @State private var session = AppSession()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .tint(Theme.accent)
                .task { await session.bootstrap() }
        }
    }
}
