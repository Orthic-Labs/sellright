import SwiftUI

@MainActor
struct CustomersListView: View {
    @Environment(AppSession.self) private var session

    @State private var list = PaginatedList<CustomerSummary>()
    @State private var searchText = ""

    private static let pageSize = 25

    var body: some View {
        List {
            ForEach(list.items) { customer in
                NavigationLink(value: customer.id) {
                    CustomerRow(customer: customer, currency: session.activeStore?.currency ?? "USD")
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
        .navigationTitle("Customers")
        .navigationDestination(for: String.self) { id in
            CustomerDetailView(customerId: id)
        }
        .searchable(text: $searchText, prompt: "Name or email")
        .overlay {
            if let errorMessage = list.errorMessage, list.items.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load customers", systemImage: "wifi.slash")
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
        .task(id: "\(session.activeStore?.slug ?? "")|\(searchText)") {
            list.invalidate()
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

    private func fetchPage(_ page: Int) async throws -> Page<CustomerSummary> {
        var query = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "pageSize", value: "\(Self.pageSize)"),
        ]
        if !searchText.isEmpty { query.append(URLQueryItem(name: "q", value: searchText)) }
        return try await session.api.get("/v1/admin/customers", query: query)
    }
}

private struct CustomerRow: View {
    let customer: CustomerSummary
    let currency: String

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(customer.displayName).font(.subheadline.weight(.medium)).lineLimit(1)
                Text(customer.email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(Money.format(cents: customer.spent, currency: currency))
                    .font(.subheadline.weight(.semibold))
                Text("\(customer.orders) order\(customer.orders == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
