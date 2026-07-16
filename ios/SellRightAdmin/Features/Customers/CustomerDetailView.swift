import SwiftUI

struct CustomerDetailView: View {
    @Environment(AppSession.self) private var session
    let customerId: String

    @State private var customer: CustomerDetail?
    @State private var errorMessage: String?

    var body: some View {
        List {
            if let customer {
                Section {
                    LabeledContent("Name", value: customer.displayName)
                    LabeledContent("Email") {
                        HStack(spacing: 4) {
                            Text(customer.email)
                            if customer.emailVerified {
                                Image(systemName: "checkmark.seal.fill")
                                    .foregroundStyle(.green).font(.caption)
                            }
                        }
                    }
                    if let phone = customer.phone {
                        LabeledContent("Phone", value: phone)
                    }
                    LabeledContent("Since", value: customer.createdAt.formatted(date: .abbreviated, time: .omitted))
                }

                Section("Lifetime") {
                    LabeledContent("Orders", value: "\(customer.orderCount)")
                    LabeledContent("Total spent", value: Money.format(cents: customer.spent, currency: currency))
                }

                if !customer.addresses.isEmpty {
                    Section("Addresses") {
                        ForEach(customer.addresses) { address in
                            Text(address.formatted)
                                .font(.subheadline)
                                .textSelection(.enabled)
                        }
                    }
                }

                if !customer.orders.isEmpty {
                    Section("Orders") {
                        ForEach(customer.orders) { order in
                            NavigationLink(value: order.code) {
                                OrderRow(order: order)
                            }
                        }
                    }
                }
            } else if let errorMessage {
                ContentUnavailableView("Couldn't load customer", systemImage: "wifi.slash", description: Text(errorMessage))
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(customer?.displayName ?? "Customer")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: String.self) { code in
            OrderDetailView(code: code)
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private var currency: String { session.activeStore?.currency ?? "USD" }

    private func load() async {
        errorMessage = nil
        do {
            customer = try await session.api.get("/v1/admin/customers/\(customerId)")
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
