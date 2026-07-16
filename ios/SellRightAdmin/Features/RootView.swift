import SwiftUI

struct RootView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        switch session.phase {
        case .loading:
            ProgressView()
        case .loggedOut:
            LoginView()
        case .loggedIn:
            TabView {
                NavigationStack { DashboardView() }
                    .tabItem { Label("Home", systemImage: "house.fill") }
                NavigationStack { OrdersListView() }
                    .tabItem { Label("Orders", systemImage: "shippingbox.fill") }
                NavigationStack { ProductsListView() }
                    .tabItem { Label("Products", systemImage: "tag.fill") }
                NavigationStack { CustomersListView() }
                    .tabItem { Label("Customers", systemImage: "person.2.fill") }
                NavigationStack { SettingsView() }
                    .tabItem { Label("Settings", systemImage: "gearshape.fill") }
            }
        }
    }
}
