import SwiftUI

struct ProductDetailView: View {
    @Environment(AppSession.self) private var session
    let productId: String
    let productName: String

    @State private var product: ProductDetail?
    @State private var errorMessage: String?
    @State private var editingVariant: VariantDetail?

    var body: some View {
        List {
            if let product {
                Section {
                    LabeledContent("Status") { StatusBadge(text: product.status) }
                    LabeledContent("Slug", value: product.slug)
                    if let description = product.description, !description.isEmpty {
                        Text(description).font(.subheadline).foregroundStyle(.secondary).lineLimit(4)
                    }
                }
                Section("Variants") {
                    ForEach(product.variants) { variant in
                        Button {
                            editingVariant = variant
                        } label: {
                            VariantRow(variant: variant, currency: currency)
                        }
                        .buttonStyle(.plain)
                    }
                }
            } else if let errorMessage {
                ContentUnavailableView("Couldn't load product", systemImage: "wifi.slash", description: Text(errorMessage))
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(productName)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editingVariant) { variant in
            VariantEditSheet(variant: variant, currency: currency) { await load() }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private var currency: String { session.activeStore?.currency ?? "USD" }

    private func load() async {
        errorMessage = nil
        do {
            product = try await session.api.get("/v1/admin/products/\(productId)")
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct VariantRow: View {
    @Environment(\.palette) private var palette
    let variant: VariantDetail
    let currency: String

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(variant.name).font(.subheadline.weight(.medium))
                Text(variant.sku).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                HStack(spacing: 4) {
                    if let sale = variant.salePrice {
                        Text(Money.format(cents: sale, currency: currency))
                            .font(.subheadline.weight(.semibold))
                        Text(Money.format(cents: variant.price, currency: currency))
                            .font(.caption).strikethrough().foregroundStyle(.secondary)
                    } else {
                        Text(Money.format(cents: variant.price, currency: currency))
                            .font(.subheadline.weight(.semibold))
                    }
                }
                Text(variant.fulfillmentType == "physical" ? "\(variant.available) available" : variant.fulfillmentType.replacingOccurrences(of: "_", with: " "))
                    .font(.caption)
                    .foregroundStyle(variant.enabled ? palette.textMuted : palette.danger)
            }
        }
        .opacity(variant.enabled ? 1 : 0.5)
        .contentShape(Rectangle())
    }
}

struct VariantEditSheet: View {
    @Environment(\.palette) private var palette
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    let variant: VariantDetail
    let currency: String
    let onDone: () async -> Void

    @State private var priceText: String
    @State private var salePriceText: String
    @State private var enabled: Bool
    @State private var onHandText: String
    @State private var busy = false
    @State private var errorMessage: String?

    init(variant: VariantDetail, currency: String, onDone: @escaping () async -> Void) {
        self.variant = variant
        self.currency = currency
        self.onDone = onDone
        _priceText = State(initialValue: String(format: "%.2f", Double(variant.price) / 100))
        _salePriceText = State(initialValue: variant.salePrice.map { String(format: "%.2f", Double($0) / 100) } ?? "")
        _enabled = State(initialValue: variant.enabled)
        _onHandText = State(initialValue: "\(variant.onHand)")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Pricing (\(currency))") {
                    LabeledContent("Price") {
                        TextField("0.00", text: $priceText)
                            .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Sale price") {
                        TextField("none", text: $salePriceText)
                            .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                    }
                }
                Section {
                    Toggle("Enabled", isOn: $enabled)
                    if variant.fulfillmentType == "physical" {
                        LabeledContent("On-hand stock") {
                            TextField("0", text: $onHandText)
                                .keyboardType(.numberPad).multilineTextAlignment(.trailing)
                        }
                    }
                } footer: {
                    variant.fulfillmentType == "physical"
                        ? Text("\(variant.allocated) currently allocated to open orders.")
                        : Text("Fulfillment: \(variant.fulfillmentType.replacingOccurrences(of: "_", with: " ")) — no stock tracking.")
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(palette.danger)
                }
            }
            .navigationTitle(variant.sku)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await submit() } }
                        .disabled(busy || Money.parseCents(priceText) == nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let newPrice = Money.parseCents(priceText)
            let newSale = salePriceText.isEmpty ? nil : Money.parseCents(salePriceText)
            var patch = VariantPatch()
            if let newPrice, newPrice != variant.price { patch.price = newPrice }
            if let newSale, newSale != variant.salePrice { patch.salePrice = newSale }
            if enabled != variant.enabled { patch.enabled = enabled }
            if patch.price != nil || patch.salePrice != nil || patch.enabled != nil {
                let _: VariantPatchResponse = try await session.api.patch("/v1/admin/variants/\(variant.id)", body: patch)
            }
            if variant.fulfillmentType == "physical", let onHand = Int(onHandText), onHand != variant.onHand, onHand >= 0 {
                let _: StockPatchResponse = try await session.api.patch("/v1/admin/variants/\(variant.id)/stock", body: StockPatch(onHand: onHand))
            }
            Diagnostics.record("variant_updated")
            await onDone()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
