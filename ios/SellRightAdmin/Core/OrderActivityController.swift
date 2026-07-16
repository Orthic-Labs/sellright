import ActivityKit
import Foundation

/// Local control of order Live Activities.
///
/// The server STARTS an activity via push-to-start when an order is paid (see
/// packages/api/src/push/outbox.ts). Moving it forward is done locally, from the
/// app, because the operator fulfilling the order IS the person holding the
/// phone — no per-activity push token needs to exist for that flow.
///
/// Known limitation: an order fulfilled from the WEB admin does not move this
/// phone's activity; it ages out at the 8h dismissal-date. Closing that needs
/// per-activity update tokens registered server-side. Documented in ios/README.
@MainActor
enum OrderActivityController {
    /// Advance (or end) the activity for one order after the operator acts on it.
    static func update(orderCode: String, status: String, trackingCode: String?) async {
        guard let activity = Activity<OrderActivityAttributes>.activities
            .first(where: { $0.attributes.orderCode == orderCode }) else { return }

        var state = activity.content.state
        state.status = status
        state.trackingCode = trackingCode ?? state.trackingCode

        if state.isTerminal {
            // Leave it up briefly so the operator sees the result land, rather
            // than the Island blinking out mid-glance.
            await activity.end(
                ActivityContent(state: state, staleDate: nil),
                dismissalPolicy: .after(.now.addingTimeInterval(60))
            )
        } else {
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }
        Diagnostics.record("live_activity_updated", ["status": status])
    }
}
