import Foundation

// Codable mirrors of the zod schemas in packages/api/src/routes/admin*.ts.
// All money values are integer cents (see packages/shared money primitives).

struct StoreAccess: Codable, Identifiable, Hashable {
    let storeId: String
    let slug: String
    let name: String
    let currency: String
    let role: String

    var id: String { storeId }
}

struct LoginRequest: Encodable {
    let email: String
    let password: String
    var totp: String?
}

struct LoginResponse: Decodable {
    var token: String?
    var csrfToken: String?
    var twoFactorRequired: Bool?
    var admin: AdminIdentity?
    var stores: [StoreAccess]?
}

struct AdminIdentity: Codable, Hashable {
    let email: String
}

struct MeResponse: Decodable {
    let admin: AdminIdentity
    let stores: [StoreAccess]
}

// MARK: - Dashboard

struct Dashboard: Decodable {
    let store: DashboardStore
    let revenue: Int
    let orders: Int
    let aov: Int
    let pendingFulfillment: Int
    let customers: Int
    let lowStock: Int
    let recentOrders: [OrderSummary]
}

struct DashboardStore: Decodable {
    let slug: String
    let name: String
    let currency: String
}

// MARK: - Orders

struct Page<Item: Decodable>: Decodable {
    let items: [Item]
    let total: Int
    let page: Int
    let pageSize: Int
}

struct OrderSummary: Decodable, Identifiable {
    let code: String
    let state: String
    let grandTotal: Int
    let currency: String
    let placedAt: Date?
    var createdAt: Date?
    var email: String?
    var isPreOrder: Bool?

    var id: String { code }
}

struct OrderDetail: Decodable {
    let code: String
    let state: String
    let isPreOrder: Bool
    let currency: String
    let subtotal: Int
    let discountTotal: Int
    let shippingTotal: Int
    let taxTotal: Int
    let grandTotal: Int
    let placedAt: Date?
    let createdAt: Date
    let customer: OrderCustomer?
    let lines: [OrderLine]
    let payments: [OrderPayment]
    let fulfillments: [OrderFulfillment]
    let events: [OrderEvent]
}

struct OrderCustomer: Decodable {
    let id: String
    let email: String
    let firstName: String?
    let lastName: String?
    let phone: String?

    var displayName: String {
        let full = [firstName, lastName].compactMap { $0 }.joined(separator: " ")
        return full.isEmpty ? email : full
    }
}

struct OrderLine: Decodable, Identifiable {
    /// order_line id — what refund `lines[].orderLineId` keys on.
    let id: String
    let sku: String
    let name: String
    let quantity: Int
    let unitPrice: Int
    let lineTotal: Int
    let fulfilledQty: Int
    let refundedQty: Int

    /// Units still refundable on this line.
    var refundableQty: Int { max(quantity - refundedQty, 0) }

    /// Server prices a partial line refund as round(lineTotal / quantity) * qty.
    func refundAmount(for qty: Int) -> Int {
        guard quantity > 0 else { return 0 }
        return Int((Double(lineTotal) / Double(quantity)).rounded()) * qty
    }
}

struct OrderPayment: Decodable, Identifiable {
    let method: String
    let amount: Int
    let state: String
    let providerRef: String?
    let createdAt: Date

    var id: String { "\(method)-\(createdAt.timeIntervalSince1970)" }
}

struct OrderFulfillment: Decodable, Identifiable {
    let id: String
    let state: String
    let trackingCode: String?
    let carrier: String?
    let createdAt: Date
}

struct OrderEvent: Decodable, Identifiable {
    let action: String
    let fromState: String?
    let toState: String?
    let actor: String?
    let at: Date

    var id: String { "\(action)-\(at.timeIntervalSince1970)" }
}

struct FulfillRequest: Encodable {
    let state: String // "Shipped" | "Delivered"
    var trackingCode: String?
    var carrier: String?
}

struct FulfillResponse: Decodable {
    let code: String
    let fulfillment: String
}

struct RefundLineRequest: Encodable {
    let orderLineId: String
    let quantity: Int
}

struct RefundRequest: Encodable {
    var lines: [RefundLineRequest]?  // per-line; server derives the amount
    var amount: Int?                 // cents override; nil + no lines = full remaining
    var restock: Bool
    var reason: String?
}

struct RefundResponse: Decodable {
    let code: String
    let state: String
    let refunded: Int
}

struct CancelRequest: Encodable {
    var reason: String?
}

struct CancelResponse: Decodable {
    let code: String
    let state: String
}

// MARK: - Push

struct DeviceRegistration: Encodable {
    let token: String
    /// "apns" (alert token) or "live_activity" (push-to-start token).
    let kind: String
    let environment: String
    var topics: [String]?
}

struct DeviceRegistrationResponse: Decodable {
    let ok: Bool
    let topics: [String]
}

// MARK: - Customers

struct CustomerSummary: Decodable, Identifiable {
    let id: String
    let email: String
    let firstName: String?
    let lastName: String?
    let createdAt: Date
    let orders: Int
    let spent: Int

    var displayName: String {
        let full = [firstName, lastName].compactMap { $0 }.joined(separator: " ")
        return full.isEmpty ? email : full
    }
}

struct CustomerDetail: Decodable {
    let id: String
    let email: String
    let firstName: String?
    let lastName: String?
    let phone: String?
    let emailVerified: Bool
    let createdAt: Date
    let orderCount: Int
    let spent: Int
    let addresses: [CustomerAddress]
    let orders: [OrderSummary]

    var displayName: String {
        let full = [firstName, lastName].compactMap { $0 }.joined(separator: " ")
        return full.isEmpty ? email : full
    }
}

struct CustomerAddress: Decodable, Identifiable {
    let fullName: String?
    let line1: String?
    let line2: String?
    let city: String?
    let province: String?
    let postalCode: String?
    let country: String?
    let phone: String?

    var id: String { [fullName, line1, city, postalCode].compactMap { $0 }.joined(separator: "|") }

    var formatted: String {
        [fullName, line1, line2, [city, province, postalCode].compactMap { $0 }.joined(separator: " "), country]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }
}

// MARK: - Products

struct ProductSummary: Decodable, Identifiable, Hashable {
    let id: String
    let slug: String
    let name: String
    let status: String
    let assetPath: String?
    let variants: Int
    let minPrice: Int?
    let stock: Int
}

struct ProductDetail: Decodable {
    let id: String
    let slug: String
    let name: String
    let description: String?
    let status: String
    let assetPath: String?
    let variants: [VariantDetail]
}

struct VariantDetail: Decodable, Identifiable {
    let id: String
    let sku: String
    let name: String
    let price: Int
    let salePrice: Int?
    let enabled: Bool
    let fulfillmentType: String
    let onHand: Int
    let allocated: Int
    let available: Int
}

struct VariantPatch: Encodable {
    var price: Int?
    var salePrice: Int?
    var enabled: Bool?
}

struct VariantPatchResponse: Decodable {
    let id: String
}

struct StockPatch: Encodable {
    let onHand: Int
}

struct StockPatchResponse: Decodable {
    let id: String
    let onHand: Int
}

// MARK: - Errors

struct APIErrorBody: Decodable {
    let error: String
}
