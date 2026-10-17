import SwiftUI

@MainActor
struct ProductsListView: View {
    @Environment(AppSession.self) private var session

    @State private var list = PaginatedList<ProductSummary>()
    @State private var searchText = ""

    private static let pageSize = 25

    var body: some View {
        List {
            ForEach(list.items) { product in
                NavigationLink(value: product) {
                    ProductRow(product: product, currency: session.activeStore?.currency ?? "USD")
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
        .navigationTitle("Products")
        .navigationDestination(for: ProductSummary.self) { product in
            ProductDetailView(productId: product.id, productName: product.name)
        }
        .searchable(text: $searchText, prompt: "Product name")
        .overlay {
            if let errorMessage = list.errorMessage, list.items.isEmpty {
                ContentUnavailableView {
                    Label("Couldn't load products", systemImage: "wifi.slash")
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

    private func fetchPage(_ page: Int) async throws -> Page<ProductSummary> {
        var query = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "pageSize", value: "\(Self.pageSize)"),
        ]
        if !searchText.isEmpty { query.append(URLQueryItem(name: "q", value: searchText)) }
        return try await session.api.get("/v1/admin/products", query: query)
    }
}

private struct ProductRow: View {
    let product: ProductSummary
    let currency: String

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(product.name).font(.subheadline.weight(.medium)).lineLimit(2)
                Text("\(product.variants) variant\(product.variants == 1 ? "" : "s") · \(product.stock) in stock")
                    .font(.caption)
                    .foregroundStyle(product.stock <= 0 ? .red : .secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                if let minPrice = product.minPrice {
                    Text(Money.format(cents: minPrice, currency: currency))
                        .font(.subheadline.weight(.semibold))
                }
                StatusBadge(text: product.status)
            }
        }
        .padding(.vertical, 4)
    }
}
