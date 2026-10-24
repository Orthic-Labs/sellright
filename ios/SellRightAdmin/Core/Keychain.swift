import Foundation
import RightKitCredentials

/// The admin session token, on RightKit's shared SecretsStore (the Keychain owner
/// every Orthic app uses). The token is the only secret the app persists; server
/// URL and store slug live in UserDefaults.
enum Keychain {
    private static let store = try? SecretsStore(namespace: "app.sellright.ios.admin")

    static func set(_ value: String, for key: String) {
        do { try store?.setString(key, value) } catch {
            Diagnostics.record("keychain_error", ["op": "set", "message": "\(error)"])
        }
    }

    static func get(_ key: String) -> String? {
        try? store?.getString(key)
    }

    static func delete(_ key: String) {
        _ = try? store?.delete(key)
    }
}
