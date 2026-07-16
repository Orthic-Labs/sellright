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

    /// Order code from a tapped notification, awaiting navigation. RootView
    /// consumes it; lives here because this is the @Observable the views watch.
    var pendingOrderCode: String?

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
        let device = PushManager.shared.deviceToken
        token = nil
        Keychain.delete("adminToken")
        admin = nil
        stores = []
        activeStore = nil
        phase = .loggedOut
        // Unregister the device BEFORE revoking the session — both calls need the
        // token that's about to die, and a signed-out phone must stop receiving
        // this store's orders. Best-effort: local state is already cleared, and
        // the server also prunes on the next APNs 410.
        PushManager.shared.stopObservingPushToStart()
        Task {
            // Don't leave a signed-out phone with an order pinned to its lock screen.
            await PushManager.shared.endAllActivities()
            if let device {
                let _: DeviceRegistrationResponse? = try? await client.delete("/v1/admin/devices/\(device)")
            }
            let _: EmptyResponse? = try? await client.post("/v1/admin/logout")
        }
    }

    /// Register this device for push against the active store. Called after login
    /// and on store switch; also the callback APNs-token arrival routes into, so
    /// whichever of (token, login) completes last triggers the registration.
    func registerForPush(token deviceToken: String, environment: String, kind: String = "apns") async {
        guard phase == .loggedIn, activeStore != nil else { return }
        do {
            let _: DeviceRegistrationResponse = try await api.post(
                "/v1/admin/devices",
                body: DeviceRegistration(token: deviceToken, kind: kind, environment: environment, topics: nil)
            )
            Diagnostics.record("push_registered", ["store": activeStore?.slug ?? "", "kind": kind])
        } catch {
            // Never block the operator on push wiring — worst case they get no
            // alerts and the next launch retries.
            Diagnostics.record("push_register_error", ["message": error.localizedDescription])
        }
    }

    private func apply(admin: AdminIdentity, stores: [StoreAccess]) {
        self.admin = admin
        self.stores = stores
        let lastSlug = UserDefaults.standard.string(forKey: "storeSlug")
        self.activeStore = stores.first(where: { $0.slug == lastSlug }) ?? stores.first
        phase = .loggedIn

        // Push setup runs after auth, never before: registration needs a session,
        // and prompting for notifications on the login screen (before the
        // operator has seen anything work) is how you get a permanent "Don't
        // Allow". The APNs token can arrive before or after this, so both paths
        // funnel through registerForPush.
        PushManager.shared.registrar = { [weak self] token, environment in
            await self?.registerForPush(token: token, environment: environment)
        }
        PushManager.shared.onOrderOpened = { [weak self] code in
            self?.pendingOrderCode = code
        }
        // Live Activity push-to-start: a separate token family from the alert
        // token, so it registers separately (kind: live_activity).
        PushManager.shared.observePushToStartToken { [weak self] token in
            await self?.registerForPush(token: token, environment: PushManager.shared.apnsEnvironment, kind: "live_activity")
        }
        Task {
            // Drain a notification tapped from a cold launch, now that there's
            // somewhere to put it.
            PushManager.shared.flushBufferedOrderCode()
            await PushManager.shared.requestAuthorization()
            // Token already in hand from an earlier launch: register it for THIS
            // store, since the operator may have switched stores since.
            if let existing = PushManager.shared.deviceToken {
                await registerForPush(token: existing, environment: PushManager.shared.apnsEnvironment)
            }
        }
    }
}
