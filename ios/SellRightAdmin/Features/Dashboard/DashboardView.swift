import SwiftUI

struct DashboardView: View {
    @Environment(AppSession.self) private var session

    @State private var dashboard: Dashboard?
    @State private var errorMessage: String?

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let d = dashboard {
                    LazyVGrid(columns: columns, spacing: 12) {
                        KPICard(title: "Revenue", value: Money.format(cents: d.revenue, currency: d.store.currency))
                        KPICard(title: "Orders", value: "\(d.orders)")
                        KPICard(title: "Avg. order", value: Money.format(cents: d.aov, currency: d.store.currency))
                        KPICard(title: "To fulfill", value: "\(d.pendingFulfillment)", highlight: d.pendingFulfillment > 0)
                        KPICard(title: "Customers", value: "\(d.customers)")
                        KPICard(title: "Low stock", value: "\(d.lowStock)", highlight: d.lowStock > 0)
                    }

                    Text("Recent orders").font(.headline).padding(.top, 8)
                    VStack(spacing: 0) {
                        ForEach(d.recentOrders) { order in
                            NavigationLink(value: order.code) {
                                OrderRow(order: order)
                            }
                            .buttonStyle(.plain)
                            Divider()
                        }
                    }
                } else if let errorMessage {
                    ContentUnavailableView("Couldn't load dashboard", systemImage: "wifi.slash", description: Text(errorMessage))
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                }
            }
            .padding()
        }
        .navigationTitle(session.activeStore?.name ?? "Dashboard")
        .navigationDestination(for: String.self) { code in
            OrderDetailView(code: code)
        }
        .refreshable { await load() }
        .task(id: session.activeStore?.slug) { await load() }
    }

    private func load() async {
        errorMessage = nil
        do {
            dashboard = try await session.api.get("/v1/admin/dashboard")
        } catch {
            errorMessage = error.localizedDescription
            Diagnostics.record("dashboard_error", ["message": error.localizedDescription])
        }
    }
}

private struct KPICard: View {
    @Environment(\.palette) private var palette
    let title: String
    let value: String
    var highlight = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(palette.textMuted)
            Text(value)
                .font(.title3.weight(.semibold))
                .foregroundStyle(highlight ? palette.accent : palette.text)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(palette.surface2, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.border, lineWidth: 1))
    }
}

struct OrderRow: View {
    @Environment(\.palette) private var palette
    let order: OrderSummary

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(order.code).font(.subheadline.weight(.medium)).foregroundStyle(palette.text)
                if let email = order.email {
                    Text(email).font(.caption).foregroundStyle(palette.textMuted).lineLimit(1)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(Money.format(cents: order.grandTotal, currency: order.currency))
                    .font(.subheadline.weight(.semibold))
                StatusBadge(text: order.state)
            }
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}
