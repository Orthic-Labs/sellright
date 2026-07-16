import ActivityKit
import SwiftUI
import WidgetKit

/// Live Activity for an order in flight: lock screen banner + Dynamic Island.
///
/// Why an order (and not a "new order" toast): a Live Activity earns its place
/// only when there's a *lifecycle* to watch. An order moves Paid → Shipped →
/// Delivered, so the Island is showing state that actually changes. A one-shot
/// "you got an order" alert is a notification — that path exists separately.
struct OrderLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OrderActivityAttributes.self) { context in
            // Lock screen / banner presentation.
            LockScreenView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.attributes.orderCode, systemImage: "shippingbox.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(Money.format(cents: context.state.grandTotal, currency: context.attributes.currency))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        StatusTrack(status: context.state.status)
                        HStack {
                            Text("\(context.state.itemCount) item\(context.state.itemCount == 1 ? "" : "s")")
                            if let tracking = context.state.trackingCode {
                                Spacer()
                                Text(tracking).lineLimit(1).truncationMode(.middle)
                            }
                        }
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.7))
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: icon(for: context.state.status))
                    .foregroundStyle(tint(for: context.state.status))
            } compactTrailing: {
                Text(Money.compact(cents: context.state.grandTotal, currency: context.attributes.currency))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tint(for: context.state.status))
            } minimal: {
                Image(systemName: icon(for: context.state.status))
                    .foregroundStyle(tint(for: context.state.status))
            }
            .keylineTint(tint(for: context.state.status))
        }
    }

    private func icon(for status: String) -> String {
        switch status {
        case "Shipped": return "shippingbox.fill"
        case "Delivered": return "checkmark.circle.fill"
        default: return "creditcard.fill"
        }
    }

    private func tint(for status: String) -> Color {
        switch status {
        case "Shipped": return .blue
        case "Delivered": return .green
        default: return Color(red: 1.0, green: 0.38, blue: 0.08) // paid — vermillion
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<OrderActivityAttributes>

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                Text(context.attributes.orderCode)
                    .font(.headline)
                    .foregroundStyle(.white)
                Text("\(context.state.itemCount) item\(context.state.itemCount == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.7))
                StatusTrack(status: context.state.status)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 5) {
                Text(Money.format(cents: context.state.grandTotal, currency: context.attributes.currency))
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.white)
                if let tracking = context.state.trackingCode {
                    Text(tracking)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1)
                }
            }
        }
        .padding()
    }
}

/// Three-step progress: Paid → Shipped → Delivered. Shape + color, never color
/// alone — the same colorblind-safe rule the web admin's status dots follow.
private struct StatusTrack: View {
    let status: String

    private var stepIndex: Int {
        switch status {
        case "Shipped": return 1
        case "Delivered": return 2
        default: return 0
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(["Paid", "Shipped", "Delivered"].enumerated()), id: \.offset) { index, label in
                let done = index <= stepIndex
                HStack(spacing: 3) {
                    Image(systemName: done ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 9))
                    Text(label).font(.system(size: 9, weight: done ? .semibold : .regular))
                }
                .foregroundStyle(done ? .white : .white.opacity(0.45))
                if index < 2 {
                    Rectangle()
                        .frame(height: 1)
                        .frame(maxWidth: 10)
                        .foregroundStyle(.white.opacity(index < stepIndex ? 0.8 : 0.25))
                }
            }
        }
    }
}
