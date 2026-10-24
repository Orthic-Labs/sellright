import Foundation

/// Persisted account metadata. Credentials are stored separately in Keychain.
struct StoreProfile: Codable, Identifiable, Equatable {
    var id: UUID
    var serverURLString: String
    var email: String
    var storeName: String?
    var storeSlug: String?
    var requiresLogin: Bool = false

    var displayName: String { storeName ?? URL(string: serverURLString)?.host() ?? serverURLString }
    var credentialKey: String { "profile.\(id.uuidString).adminToken" }
}
