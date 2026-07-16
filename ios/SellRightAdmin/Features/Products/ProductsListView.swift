import SwiftUI

struct ProductsListView: View {
    @Environment(AppSession.self) private var session

    @State private var products: [ProductSummary] = []
    @State private var total = 0
    @State private var page = 1
    @State private var searchText = ""
    @State private var loading = false
    @State private var errorMessage: String?

    private static let pageSize = 25

    var body: some View {
        List {
            ForEach(products) { product in
                NavigationLink(value: product) {
                    ProductRow(product: product, currency: session.activeStore?.currency ?? "USD")
                }
            }
            if products.count < total {
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
            if let errorMessage, products.isEmpty {
                ContentUnavailableView("Couldn't load products", systemImage: "wifi.slash", description: Text(errorMessage))
            } else if products.isEmpty, !loading {
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
            let result: Page<ProductSummary> = try await session.api.get("/v1/admin/products", query: query)
            products = replace ? result.items : products + result.items
            total = result.total
        } catch {
            if replace { products = [] }
            errorMessage = error.localizedDescription
        }
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
