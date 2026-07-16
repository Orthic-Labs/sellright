import ActivityKit
import Foundation

/// Live Activity contract for a single order's lifecycle. Compiled into BOTH the
/// app and the widget extension (see project.yml `sources`), because ActivityKit
/// matches activities by this type — a drifting copy silently fails to update.
///
/// The server sends `contentState` as the `content-state` of a `liveactivity`
/// APNs push, so these CodingKeys ARE a wire contract: renaming a property
/// without updating the server means the push is rejected as malformed.
struct OrderActivityAttributes: ActivityAttributes {
    /// Fixed for the life of the activity — set once at start.
    let orderCode: String
    let currency: String

    /// The part that changes as the operator works the order.
    struct ContentState: Codable, Hashable {
        /// 'Paid' | 'Shipped' | 'Delivered' — mirrors the server's order state.
        var status: String
        /// Integer cents, like every other money value in this product.
        var grandTotal: Int
        var itemCount: Int
        /// Set once shipped, shown in the expanded view.
        var trackingCode: String?

        var isTerminal: Bool { status == "Delivered" || status == "Cancelled" }
    }
}
