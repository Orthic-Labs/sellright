import SwiftUI

struct OrderDetailView: View {
    @Environment(AppSession.self) private var session
    let code: String

    @State private var order: OrderDetail?
    @State private var errorMessage: String?
    @State private var showFulfillSheet = false
    @State private var showRefundSheet = false
    @State private var showCancelConfirm = false
    @State private var actionError: String?

    var body: some View {
        List {
            if let order {
                Section {
                    HStack {
                        Text(Money.format(cents: order.grandTotal, currency: order.currency))
                            .font(.title2.weight(.bold))
                        Spacer()
                        StatusBadge(text: order.state)
                    }
                    if let placedAt = order.placedAt {
                        LabeledContent("Placed", value: placedAt.formatted(date: .abbreviated, time: .shortened))
                    }
                    if order.isPreOrder {
                        Label("Pre-order", systemImage: "clock.badge.exclamationmark")
                            .foregroundStyle(.orange)
                    }
                }

                if let customer = order.customer {
                    Section("Customer") {
                        LabeledContent("Name", value: customer.displayName)
                        LabeledContent("Email", value: customer.email)
                        if let phone = customer.phone {
                            LabeledContent("Phone", value: phone)
                        }
                    }
                }

                Section("Items") {
                    ForEach(order.lines) { line in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(line.name).font(.subheadline)
                                Text(line.sku).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("\(line.quantity) × \(Money.format(cents: line.unitPrice, currency: order.currency))")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(Money.format(cents: line.lineTotal, currency: order.currency))
                                    .font(.subheadline.weight(.medium))
                            }
                        }
                    }
                }

                Section("Totals") {
                    LabeledContent("Subtotal", value: Money.format(cents: order.subtotal, currency: order.currency))
                    if order.discountTotal != 0 {
                        LabeledContent("Discount", value: "−" + Money.format(cents: order.discountTotal, currency: order.currency))
                    }
                    LabeledContent("Shipping", value: Money.format(cents: order.shippingTotal, currency: order.currency))
                    LabeledContent("Tax", value: Money.format(cents: order.taxTotal, currency: order.currency))
                    LabeledContent("Total", value: Money.format(cents: order.grandTotal, currency: order.currency))
                        .fontWeight(.semibold)
                }

                if !order.payments.isEmpty {
                    Section("Payments") {
                        ForEach(order.payments) { payment in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(payment.method)
                                    Spacer()
                                    Text(Money.format(cents: payment.amount, currency: order.currency))
                                }
                                .font(.subheadline)
                                Text(payment.state).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if !order.fulfillments.isEmpty {
                    Section("Fulfillment") {
                        ForEach(order.fulfillments) { fulfillment in
                            VStack(alignment: .leading, spacing: 2) {
                                StatusBadge(text: fulfillment.state)
                                if let tracking = fulfillment.trackingCode {
                                    Text("\(fulfillment.carrier ?? "Tracking"): \(tracking)")
                                        .font(.caption)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                }

                if !order.events.isEmpty {
                    Section("Activity") {
                        ForEach(order.events) { event in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(eventTitle(event)).font(.subheadline)
                                Text(event.at.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } else if let errorMessage {
                ContentUnavailableView("Couldn't load order", systemImage: "wifi.slash", description: Text(errorMessage))
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(code)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if hasActions {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if canFulfill {
                            Button("Fulfill…", systemImage: "shippingbox") { showFulfillSheet = true }
                        }
                        if canRefund {
                            Button("Refund…", systemImage: "arrow.uturn.backward.circle") { showRefundSheet = true }
                        }
                        if canCancel {
                            Button("Cancel order…", systemImage: "xmark.circle", role: .destructive) { showCancelConfirm = true }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .sheet(isPresented: $showFulfillSheet) {
            FulfillSheet(code: code) { await load() }
        }
        .sheet(isPresented: $showRefundSheet) {
            if let order {
                RefundSheet(
                    code: code,
                    currency: order.currency,
                    grandTotal: order.grandTotal,
                    lines: order.lines
                ) { await load() }
            }
        }
        .confirmationDialog("Cancel order \(code)?", isPresented: $showCancelConfirm, titleVisibility: .visible) {
            Button("Cancel order", role: .destructive) { Task { await cancelOrder() } }
            Button("Keep order", role: .cancel) {}
        } message: {
            Text("Releases reserved stock for unshipped items. This can't be undone.")
        }
        .alert("Action failed", isPresented: .init(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private var writable: Bool { session.activeStore?.role != "viewer" }

    private var canFulfill: Bool {
        guard let order else { return false }
        return writable && (order.state == "Paid" || order.state == "PartiallyRefunded")
            && !order.fulfillments.contains(where: { $0.state == "Delivered" })
    }

    private var canRefund: Bool {
        guard let order else { return false }
        return writable && (order.state == "Paid" || order.state == "PartiallyRefunded")
    }

    private var canCancel: Bool {
        guard let order else { return false }
        // Server enforces the exact transition table; mirror the obvious dead ends.
        return writable && order.state != "Cancelled" && order.state != "Refunded"
    }

    private var hasActions: Bool { canFulfill || canRefund || canCancel }

    private func cancelOrder() async {
        do {
            let _: CancelResponse = try await session.api.post(
                "/v1/admin/orders/\(code)/cancel", body: CancelRequest(reason: nil)
            )
            Diagnostics.record("order_cancelled")
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func eventTitle(_ event: OrderEvent) -> String {
        if let from = event.fromState, let to = event.toState {
            return "\(event.action): \(from) → \(to)"
        }
        return event.action
    }

    private func load() async {
        errorMessage = nil
        do {
            order = try await session.api.get("/v1/admin/orders/\(code)")
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct FulfillSheet: View {
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    let code: String
    let onDone: () async -> Void

    @State private var state = "Shipped"
    @State private var trackingCode = ""
    @State private var carrier = ""
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Picker("Status", selection: $state) {
                    Text("Shipped").tag("Shipped")
                    Text("Delivered").tag("Delivered")
                }
                .pickerStyle(.segmented)
                Section("Tracking (optional)") {
                    TextField("Tracking code", text: $trackingCode)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.characters)
                    TextField("Carrier", text: $carrier)
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
            .navigationTitle("Fulfill \(code)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await submit() } }
                        .disabled(busy)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func submit() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            let _: FulfillResponse = try await session.api.post(
                "/v1/admin/orders/\(code)/fulfill",
                body: FulfillRequest(
                    state: state,
                    trackingCode: trackingCode.isEmpty ? nil : trackingCode,
                    carrier: carrier.isEmpty ? nil : carrier
                )
            )
            Diagnostics.record("order_fulfilled", ["state": state])
            await onDone()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
