import SwiftUI

/// Three refund modes, matching what the server accepts:
///   • full     — no lines, no amount: server refunds the remaining balance
///   • lines    — per-line quantities: server derives the amount from them
///   • amount   — explicit cents override
struct RefundSheet: View {
    enum Mode: String, CaseIterable {
        case full = "Full"
        case lines = "By item"
        case amount = "Amount"
    }

    @Environment(\.palette) private var palette
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    let code: String
    let currency: String
    let grandTotal: Int
    let lines: [OrderLine]
    let onDone: () async -> Void

    @State private var mode: Mode = .full
    @State private var quantities: [String: Int] = [:]
    @State private var amountText = ""
    @State private var restock = false
    @State private var reason = ""
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Mode", selection: $mode) {
                        ForEach(availableModes, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }

                switch mode {
                case .full:
                    Section {
                        LabeledContent("Refund", value: Money.format(cents: grandTotal, currency: currency))
                    } footer: {
                        Text("Refunds the remaining balance — the server subtracts anything already refunded.")
                    }
                case .lines:
                    Section("Items") {
                        ForEach(refundableLines) { line in
                            RefundLineRow(
                                line: line,
                                currency: currency,
                                quantity: Binding(
                                    get: { quantities[line.id] ?? 0 },
                                    set: { quantities[line.id] = $0 }
                                )
                            )
                        }
                    }
                    Section {
                        LabeledContent("Refund total", value: Money.format(cents: linesTotal, currency: currency))
                            .fontWeight(.semibold)
                    }
                case .amount:
                    Section {
                        TextField("Amount (e.g. 49.99)", text: $amountText)
                            .keyboardType(.decimalPad)
                    } footer: {
                        Text("Order total \(Money.format(cents: grandTotal, currency: currency)). The server caps this at the remaining refundable balance.")
                    }
                }

                Section {
                    Toggle("Restock items", isOn: $restock)
                    TextField("Reason (optional)", text: $reason)
                }

                if let errorMessage {
                    Text(errorMessage).foregroundStyle(palette.danger)
                }
            }
            .navigationTitle("Refund \(code)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Refund") { Task { await submit() } }
                        .disabled(busy || !canSubmit)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// "By item" only makes sense when something is still refundable per line.
    private var availableModes: [Mode] {
        refundableLines.isEmpty ? [.full, .amount] : Mode.allCases
    }

    private var refundableLines: [OrderLine] {
        lines.filter { $0.refundableQty > 0 }
    }

    private var selectedLines: [RefundLineRequest] {
        refundableLines.compactMap { line in
            let qty = quantities[line.id] ?? 0
            return qty > 0 ? RefundLineRequest(orderLineId: line.id, quantity: qty) : nil
        }
    }

    private var linesTotal: Int {
        refundableLines.reduce(0) { sum, line in
            sum + line.refundAmount(for: quantities[line.id] ?? 0)
        }
    }

    private var canSubmit: Bool {
        switch mode {
        case .full: return true
        case .lines: return !selectedLines.isEmpty
        case .amount: return (Money.parseCents(amountText) ?? 0) > 0
        }
    }

    private func submit() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        let body: RefundRequest
        switch mode {
        case .full:
            body = RefundRequest(lines: nil, amount: nil, restock: restock, reason: reasonOrNil)
        case .lines:
            body = RefundRequest(lines: selectedLines, amount: nil, restock: restock, reason: reasonOrNil)
        case .amount:
            body = RefundRequest(lines: nil, amount: Money.parseCents(amountText), restock: restock, reason: reasonOrNil)
        }
        do {
            let _: RefundResponse = try await session.api.post("/v1/admin/orders/\(code)/refund", body: body)
            Diagnostics.record("order_refunded", ["mode": mode.rawValue])
            await onDone()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private var reasonOrNil: String? { reason.isEmpty ? nil : reason }
}

private struct RefundLineRow: View {
    let line: OrderLine
    let currency: String
    @Binding var quantity: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(line.name).font(.subheadline).lineLimit(1)
                    Text(line.sku).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(Money.format(cents: line.refundAmount(for: quantity), currency: currency))
                    .font(.subheadline.weight(quantity > 0 ? .semibold : .regular))
                    .foregroundStyle(quantity > 0 ? .primary : .secondary)
            }
            Stepper(
                "Refund \(quantity) of \(line.refundableQty)",
                value: $quantity,
                in: 0...line.refundableQty
            )
            .font(.caption)
            if line.refundedQty > 0 {
                Text("\(line.refundedQty) already refunded")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
