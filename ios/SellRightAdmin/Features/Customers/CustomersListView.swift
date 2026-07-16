import SwiftUI

struct CustomersListView: View {
    @Environment(AppSession.self) private var session

    @State private var customers: [CustomerSummary] = []
    @State private var total = 0
    @State private var page = 1
    @State private var searchText = ""
    @State private var loading = false
    @State private var errorMessage: String?

    private static let pageSize = 25

    var body: some View {
        List {
            ForEach(customers) { customer in
                NavigationLink(value: customer.id) {
                    CustomerRow(customer: customer, currency: session.activeStore?.currency ?? "USD")
                }
            }
            if customers.count < total {
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
            if let errorMessage, customers.isEmpty {
                ContentUnavailableView("Couldn't load customers", systemImage: "wifi.slash", description: Text(errorMessage))
            } else if customers.isEmpty, !loading {
                ContentUnavailableView.search
            }
        }
        .refreshable { await reload() }
        .task(id: "\(session.activeStore?.slug ?? "")|\(searchText)") {
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
        do {
            let result: Page<CustomerSummary> = try await session.api.get("/v1/admin/customers", query: query)
            customers = replace ? result.items : customers + result.items
            total = result.total
        } catch {
            if replace { customers = [] }
            errorMessage = error.localizedDescription
        }
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
