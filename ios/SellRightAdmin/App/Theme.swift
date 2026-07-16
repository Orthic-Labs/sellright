import SwiftUI

/// Placeholder visual tokens. SellRight has no locked Right Suite identity yet
/// (fonts/colors TBD — when locked, the wordmark renders in Tanker with the
/// "Right" half in the app accent, per suite rules). Keep everything routed
/// through this enum so the identity drop-in is one file.
enum Theme {
    static let accent = Color(red: 0.05, green: 0.52, blue: 0.41)

    static func statusColor(_ state: String) -> Color {
        switch state {
        case "Paid": return .green
        case "PaymentPending", "Draft": return .orange
        case "Cancelled": return .red
        case "Refunded", "PartiallyRefunded": return .purple
        case "Shipped", "Delivered": return .blue
        default: return .secondary
        }
    }
}

/// Small capsule badge used for order/product states across screens.
struct StatusBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Theme.statusColor(text).opacity(0.15), in: Capsule())
            .foregroundStyle(Theme.statusColor(text))
    }
}
