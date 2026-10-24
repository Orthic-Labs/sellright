import Foundation
import RightKitCredentials

@MainActor
protocol SessionCredentialStore {
    func read(_ key: String) throws -> String?
    func write(_ value: String, for key: String) throws
    func remove(_ key: String) throws
}

struct KeychainCredentials: SessionCredentialStore {
    func read(_ key: String) throws -> String? { try Keychain.get(key) }
    func write(_ value: String, for key: String) throws { try Keychain.set(value, for: key) }
    func remove(_ key: String) throws { try Keychain.delete(key) }
}

/// RightKit owns Keychain access. Initialization & write failures must propagate:
/// a successful login must never claim a credential was saved when it was not.
enum Keychain {
    static func set(_ value: String, for key: String) throws {
        try SecretsStore(namespace: "app.sellright.ios.admin").setString(key, value)
    }

    static func get(_ key: String) throws -> String? {
        try SecretsStore(namespace: "app.sellright.ios.admin").getString(key)
    }

    static func delete(_ key: String) throws {
        _ = try SecretsStore(namespace: "app.sellright.ios.admin").delete(key)
    }
}
