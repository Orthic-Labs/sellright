import SwiftUI

struct RootView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        switch session.phase {
        case .loading:
            ProgressView()
        case .loggedOut:
            LoginView(profile: session.profiles.first(where: { $0.id == session.activeProfileID }))
        case .loggedIn:
            // Recreate navigation, tab and order state for each account, server,
            // and store identity so matching slugs never expose stale content.
            AuthenticatedRootView()
                .id(session.sessionIdentity)
        }
    }
}

private struct AuthenticatedRootView: View {
    @Environment(AppSession.self) private var session
    @Environment(\.scenePhase) private var scenePhase

    /// Selected tab, driven programmatically so a tapped notification can jump
    /// to Orders regardless of where the operator was.
    @State private var tab = Tab.home
    /// Order pushed onto the Orders stack by a notification tap.
    @State private var ordersPath: [String] = []

    enum Tab: Hashable { case home, orders, products, customers, settings }

    var body: some View {
        TabView(selection: $tab) {
            SwiftUI.Tab("Home", systemImage: "house", value: Tab.home) {
                NavigationStack { DashboardView() }
            }
            SwiftUI.Tab("Orders", systemImage: "shippingbox", value: Tab.orders) {
                NavigationStack(path: $ordersPath) { OrdersListView() }
            }
            SwiftUI.Tab("Products", systemImage: "tag", value: Tab.products) {
                NavigationStack { ProductsListView() }
            }
            SwiftUI.Tab("Customers", systemImage: "person.2", value: Tab.customers) {
                NavigationStack { CustomersListView() }
            }
            SwiftUI.Tab("Settings", systemImage: "gearshape", value: Tab.settings) {
                NavigationStack { SettingsView() }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .minimizingTabBarOnScroll()
        // A tapped notification sets session.pendingOrderCode (buffered
        // through a cold launch by PushManager); navigate whenever one lands.
        .onChange(of: session.pendingOrderCode) { _, code in
            if code != nil { openPendingOrder() }
        }
        .onAppear { openPendingOrder() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                openPendingOrder()
                if tab == .orders { PushManager.shared.clearBadge() }
            }
        }
        .onChange(of: tab) { _, newTab in
            if newTab == .orders { PushManager.shared.clearBadge() }
        }
    }

    private func openPendingOrder() {
        guard let code = session.pendingOrderCode else { return }
        session.pendingOrderCode = nil
        tab = .orders
        ordersPath = [code]
        PushManager.shared.clearBadge()
    }
}

private extension View {
    /// iOS 26+: the tab bar shrinks while a list scrolls down, giving the content the screen.
    @ViewBuilder
    func minimizingTabBarOnScroll() -> some View {
        if #available(iOS 26.0, *) {
            tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
    }
}
