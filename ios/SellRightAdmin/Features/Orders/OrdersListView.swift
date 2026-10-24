import SwiftUI

@MainActor
struct OrdersListView: View {
    @Environment(AppSession.self) private var session

    @State private var list = PaginatedList<OrderSummary>()
    @State private var searchText = ""
    @State private var stateFilter: String?

    private static let pageSize = 25

    var body: some View {
        List {
            ForEach(list.items) { order in
                NavigationLink(value: order.code) {
                    OrderRow(order: order)
                }
            }
            if let errorMessage = list.errorMessage, !list.items.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(errorMessage).font(.caption).foregroundStyle(.secondary)
                    Button("Retry") { Task { await list.retry(fetch: fetchPage) } }
                }
            } else if list.hasMore {
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
        .safeAreaInset(edge: .top, spacing: 0) {
            OrdersSearchControls()
        }
        .searchable(text: $searchText, prompt: "Order code or email")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("State", selection: $stateFilter) {
                        Text("All states").tag(String?.none)
                        ForEach(OrderStateFilter.allCases, id: \.self) { state in
                            Text(state.title).tag(String?.some(state.rawValue))
                        }
                    }
                } label: {
                    Image(systemName: stateFilter == nil
                        ? "line.3.horizontal.decrease.circle"
                        : "line.3.horizontal.decrease.circle.fill")
                }
            }
        }
        .overlay {
            if let errorMessage = list.errorMessage, list.items.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load orders", systemImage: "wifi.slash")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Retry") { Task { await list.retry(fetch: fetchPage) } }
                }
            } else if list.items.isEmpty, !list.loading {
                ContentUnavailableView.search
            }
        }
        .refreshable { await reload() }
        .task(id: "\(session.activeStore?.slug ?? "")|\(searchText)|\(stateFilter ?? "")") {
            list.invalidate()
            // Debounce keystrokes; task(id:) cancels the previous sleep.
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await reload()
        }
    }

    private func reload() async {
        await list.load(replacing: true, fetch: fetchPage)
    }

    private func loadMore() async {
        await list.load(replacing: false, fetch: fetchPage)
    }

    private func fetchPage(_ page: Int) async throws -> Page<OrderSummary> {
        var query = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "pageSize", value: "\(Self.pageSize)"),
        ]
        if !searchText.isEmpty { query.append(URLQueryItem(name: "q", value: searchText)) }
        if let stateFilter { query.append(URLQueryItem(name: "state", value: stateFilter)) }
        return try await session.api.get("/v1/admin/orders", query: query)
    }
}

private struct OrdersSearchControls: View {
    @Environment(\.isSearching) private var isSearching
    @Environment(\.dismissSearch) private var dismissSearch

    var body: some View {
        if isSearching {
            HStack {
                Spacer()
                Button {
                    dismissSearch()
                } label: {
                    Text("Done")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityIdentifier("orders.search.done")
            }
            .padding(.horizontal)
            .background(.bar)
        }
    }
}
