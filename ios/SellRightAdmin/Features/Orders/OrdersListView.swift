import SwiftUI

struct OrdersListView: View {
    @Environment(AppSession.self) private var session

    @State private var orders: [OrderSummary] = []
    @State private var total = 0
    @State private var page = 1
    @State private var searchText = ""
    @State private var stateFilter: String?
    @State private var loading = false
    @State private var errorMessage: String?

    private static let states = ["Paid", "PaymentPending", "Shipped", "Delivered", "Cancelled", "Refunded"]
    private static let pageSize = 25

    var body: some View {
        List {
            ForEach(orders) { order in
                NavigationLink(value: order.code) {
                    OrderRow(order: order)
                }
            }
            if orders.count < total {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .onAppear { Task { await loadMore() } }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Orders")
        .navigationDestination(for: String.self) { code in
            OrderDetailView(code: code)
        }
        .searchable(text: $searchText, prompt: "Order code or email")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("State", selection: $stateFilter) {
                        Text("All states").tag(String?.none)
                        ForEach(Self.states, id: \.self) { Text($0).tag(String?.some($0)) }
                    }
                } label: {
                    Image(systemName: stateFilter == nil
                        ? "line.3.horizontal.decrease.circle"
                        : "line.3.horizontal.decrease.circle.fill")
                }
            }
        }
        .overlay {
            if let errorMessage, orders.isEmpty {
                ContentUnavailableView("Couldn't load orders", systemImage: "wifi.slash", description: Text(errorMessage))
            } else if orders.isEmpty, !loading {
                ContentUnavailableView.search
            }
        }
        .refreshable { await reload() }
        .task(id: "\(session.activeStore?.slug ?? "")|\(searchText)|\(stateFilter ?? "")") {
            // Debounce keystrokes; task(id:) cancels the previous sleep.
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await reload()
        }
    }

    private func reload() async {
        page = 1
        await fetch(replace: true)
    }

    private func loadMore() async {
        guard !loading else { return }
        page += 1
        await fetch(replace: false)
    }

    private func fetch(replace: Bool) async {
        loading = true
        errorMessage = nil
        defer { loading = false }
        var query = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "pageSize", value: "\(Self.pageSize)"),
        ]
        if !searchText.isEmpty { query.append(URLQueryItem(name: "q", value: searchText)) }
        if let stateFilter { query.append(URLQueryItem(name: "state", value: stateFilter)) }
        do {
            let result: Page<OrderSummary> = try await session.api.get("/v1/admin/orders", query: query)
            orders = replace ? result.items : orders + result.items
            total = result.total
        } catch {
            if replace { orders = [] }
            errorMessage = error.localizedDescription
        }
    }
}
