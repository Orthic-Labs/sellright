import SwiftUI

struct RootView: View {
    @Environment(AppSession.self) private var session
    @Environment(\.scenePhase) private var scenePhase

    /// Selected tab, driven programmatically so a tapped notification can jump
    /// to Orders regardless of where the operator was.
    @State private var tab = Tab.home
    /// Order pushed onto the Orders stack by a notification tap.
    @State private var ordersPath: [String] = []

    enum Tab: Hashable { case home, orders, products, customers, settings }

    var body: some View {
        switch session.phase {
        case .loading:
            ProgressView()
        case .loggedOut:
            LoginView()
        case .loggedIn:
            // Tab API: a tab bar on iPhone, a sidebar the operator can toggle on iPad.
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
                // Returning to the foreground also clears a badge the operator
                // has now effectively seen.
                if phase == .active {
                    openPendingOrder()
                    if tab == .orders { PushManager.shared.clearBadge() }
                }
            }
            .onChange(of: tab) { _, newTab in
                if newTab == .orders { PushManager.shared.clearBadge() }
            }
        }
    }

    private func openPendingOrder() {
        guard let code = session.pendingOrderCode else { return }
        session.pendingOrderCode = nil
        tab = .orders
        // Replace rather than append: two notifications in a row shouldn't build
        // a stack of orders the operator has to unwind.
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
