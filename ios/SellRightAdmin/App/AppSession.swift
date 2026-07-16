import Foundation
import Observation

/// Global auth + store-selection state. Token persists in the Keychain;
/// server URL and last store slug in UserDefaults. On launch we revalidate
/// the stored token against /v1/admin/me.
@MainActor
@Observable
final class AppSession {
    enum Phase {
        case loading
        case loggedOut
        case loggedIn
    }

    private(set) var phase: Phase = .loading
    private(set) var admin: AdminIdentity?
    private(set) var stores: [StoreAccess] = []
    var activeStore: StoreAccess? {
        didSet { UserDefaults.standard.set(activeStore?.slug, forKey: "storeSlug") }
    }

    var serverURLString: String =
        UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:3300"

    private var token: String?

    var api: APIClient {
        APIClient(
            baseURL: URL(string: serverURLString) ?? URL(filePath: "/"),
            token: token,
            storeSlug: activeStore?.slug
        )
    }

    func bootstrap() async {
        guard let stored = Keychain.get("adminToken"),
              URL(string: serverURLString) != nil else {
            phase = .loggedOut
            return
        }
        token = stored
        do {
            let me: MeResponse = try await api.get("/v1/admin/me")
            apply(admin: me.admin, stores: me.stores)
        } catch {
            // Expired/revoked token or unreachable server — fall back to login.
            token = nil
            phase = .loggedOut
        }
    }

    func login(email: String, password: String, totp: String?) async throws {
        guard let url = URL(string: serverURLString), url.scheme?.hasPrefix("http") == true else {
            throw APIError.invalidURL
        }
        UserDefaults.standard.set(serverURLString, forKey: "serverURL")
        var client = api
        client.token = nil
        let res: LoginResponse = try await client.post(
            "/v1/admin/login",
            body: LoginRequest(email: email, password: password, totp: totp?.isEmpty == true ? nil : totp)
        )
        guard let newToken = res.token, let admin = res.admin else {
            throw APIError.http(status: 401, message: "invalid email, password, or 2FA code")
        }
        token = newToken
        Keychain.set(newToken, for: "adminToken")
        apply(admin: admin, stores: res.stores ?? [])
        Diagnostics.record("login", ["server": serverURLString])
    }

    func logout() async {
        let client = api
        token = nil
        Keychain.delete("adminToken")
        admin = nil
        stores = []
        activeStore = nil
        phase = .loggedOut
        // Best-effort server-side session revoke; local state is already gone.
        Task { let _: EmptyResponse? = try? await client.post("/v1/admin/logout") }
    }

    private func apply(admin: AdminIdentity, stores: [StoreAccess]) {
        self.admin = admin
        self.stores = stores
        let lastSlug = UserDefaults.standard.string(forKey: "storeSlug")
        self.activeStore = stores.first(where: { $0.slug == lastSlug }) ?? stores.first
        phase = .loggedIn
    }
}
