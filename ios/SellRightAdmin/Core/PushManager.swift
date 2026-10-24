import ActivityKit
import Foundation
import UIKit
import UserNotifications

@MainActor
protocol SessionPushManaging {
    func setSession(identity: String?, client: APIClient?)
    func revoke(client: APIClient) async
    func retireLegacySession(client: APIClient) throws
}

/// Native effects are injected at their ownership boundary, also allowing isolated
/// tests without notification permissions, ActivityKit observers or live devices.
@MainActor
protocol PushDevice {
    var environment: String { get }
    func requestAuthorization() async
    func clearNotifications()
    func endActivities() async
    func observeLiveActivityTokens(_ handler: @escaping @MainActor (String) -> Void) -> Task<Void, Never>?
}

@MainActor
struct SystemPushDevice: PushDevice {
    var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    func requestAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            Diagnostics.record("push_permission", ["granted": granted ? "true" : "false"])
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        } catch {
            Diagnostics.record("push_permission_error", ["message": error.localizedDescription])
        }
    }

    func clearNotifications() {
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
        center.setBadgeCount(0) { _ in }
    }

    func endActivities() async {
        for activity in Activity<OrderActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func observeLiveActivityTokens(_ handler: @escaping @MainActor (String) -> Void) -> Task<Void, Never>? {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }
        return Task {
            for await tokenData in Activity<OrderActivityAttributes>.pushToStartTokenUpdates {
                guard !Task.isCancelled else { return }
                handler(tokenData.map { String(format: "%02x", $0) }.joined())
            }
        }
    }
}

/// One serialized owner for device registrations across profiles & stores.
@MainActor
final class PushManager: NSObject, SessionPushManaging {
    static let shared = PushManager()
    private(set) var deviceToken: String?
    private(set) var liveActivityToken: String?
    private let device: any PushDevice
    private let defaults: UserDefaults
    private let credentials: any SessionCredentialStore
    private let recoveryTransport: APIClient.Transport?
    static let registrationsKey = "pushRegistrations.v1"
    private var identity: String?
    private var tail: Task<Void, Never>?
    private var pushToStartTask: Task<Void, Never>?
    private var registrar: (@MainActor (String, String, String) -> Void)?
    private struct Receipt: Codable {
        let id: UUID
        let serverURLString: String
        let storeSlug: String?
        let deviceToken: String?
        var revokeSession: Bool?
        var credentialKey: String { "pushCleanup.\(id.uuidString)" }
    }
    private struct Registration {
        let receipt: Receipt
        let client: APIClient?
    }
    // Receipts contain routing metadata only. Their bearer snapshot stays in
    // Keychain until confirmed cleanup, even after signout removes profile auth.
    private var registrations: [Registration] = []

    init(device: any PushDevice = SystemPushDevice(), defaults: UserDefaults = .standard,
         credentials: any SessionCredentialStore = KeychainCredentials(),
         recoveryTransport: APIClient.Transport? = nil) {
        self.device = device
        self.defaults = defaults
        self.credentials = credentials
        self.recoveryTransport = recoveryTransport
        super.init()
        if let data = defaults.data(forKey: Self.registrationsKey),
           let receipts = try? JSONDecoder().decode([Receipt].self, from: data) {
            registrations = receipts.map { Registration(receipt: $0, client: nil) }
        }
    }

    var apnsEnvironment: String { device.environment }

    func configure() { UNUserNotificationCenter.current().delegate = self }

    func setSession(identity nextIdentity: String?, client: APIClient?) {
        identity = nextIdentity
        registrar = nil
        stopObservingPushToStart()
        device.clearNotifications()
        enqueue { [weak self] in
            guard let self else { return }
            await self.endAllActivities()
            guard self.preserveLegacyCleanupReceipt() else { return }
            guard await self.cleanupRegistrations() else { return }
            guard let nextIdentity, let client, self.identity == nextIdentity else { return }
            self.registrar = { [weak self] token, environment, kind in
                self?.enqueue { [weak self] in
                    guard let self, self.identity == nextIdentity else { return }
                    await self.register(token: token, environment: environment, kind: kind,
                                        identity: nextIdentity, client: client)
                }
            }
            self.observePushToStartToken(identity: nextIdentity)
            await self.requestAuthorization()
            guard self.identity == nextIdentity else { return }
            if let token = self.deviceToken {
                await self.register(token: token, environment: self.apnsEnvironment, kind: "apns", identity: nextIdentity, client: client)
            }
            if let token = self.liveActivityToken, self.identity == nextIdentity {
                await self.register(token: token, environment: self.apnsEnvironment, kind: "live_activity", identity: nextIdentity, client: client)
            }
        }
    }

    /// Pre-receipt app versions did not persist either device token family.
    /// Retire their entire own-user session durably before fresh push registration.
    /// Queue execution stays with setSession, allowing migration to read /me first.
    func retireLegacySession(client: APIClient) throws {
        guard let bearer = client.token else { return }
        if registrations.contains(where: {
            $0.receipt.revokeSession == true && $0.receipt.serverURLString == client.baseURL.absoluteString
                && ($0.client?.token ?? (try? credentials.read($0.receipt.credentialKey))) == bearer
        }) { return }
        let receipt = Receipt(id: UUID(), serverURLString: client.baseURL.absoluteString,
                              storeSlug: nil, deviceToken: nil, revokeSession: true)
        try credentials.write(bearer, for: receipt.credentialKey)
        registrations.append(Registration(receipt: receipt, client: client))
        persistRegistrations()
    }

    func revoke(client: APIClient) async {
        let task = enqueue { [weak self] in
            guard let self else { return }
            _ = await self.cleanupRegistrations()
            // Revocation is serialized before any next profile registration.
            // Server session deletion also cascades APNs & Live Activity rows.
            let _: EmptyResponse? = try? await client.post("/v1/admin/logout")
        }
        await task.value
    }

    func waitForPendingOperations() async { await tail?.value }

    @discardableResult
    private func enqueue(_ operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = tail
        let task = Task { @MainActor in
            await previous?.value
            await operation()
        }
        tail = task
        return task
    }

    private func register(token: String, environment: String, kind: String,
                          identity expectedIdentity: String, client: APIClient) async {
        guard identity == expectedIdentity else { return }
        // Persist before sending: a timeout or process termination may follow a
        // server commit. Relaunch must clean the exact originating session first.
        if !registrations.contains(where: {
            $0.receipt.deviceToken == token && $0.receipt.serverURLString == client.baseURL.absoluteString
                && $0.client?.token == client.token && $0.receipt.storeSlug == client.storeSlug
        }) {
            guard let bearer = client.token else { return }
            let receipt = Receipt(id: UUID(), serverURLString: client.baseURL.absoluteString,
                                  storeSlug: client.storeSlug, deviceToken: token)
            do {
                try credentials.write(bearer, for: receipt.credentialKey)
                registrations.append(Registration(receipt: receipt, client: client))
                persistRegistrations()
            } catch {
                Diagnostics.record("push_register_error", ["message": "Could not save cleanup credential"])
                return
            }
        }
        do {
            let _: DeviceRegistrationResponse = try await client.post("/v1/admin/devices", body: DeviceRegistration(token: token, kind: kind, environment: environment, topics: nil))
            Diagnostics.record("push_registered", ["store": client.storeSlug ?? "", "kind": kind])
        } catch {
            Diagnostics.record("push_register_error", ["message": error.localizedDescription])
        }
    }

    private func preserveLegacyCleanupReceipt() -> Bool {
        // A failed migration/Keychain write must also block replacement pushes,
        // including a later launch that already has other saved profiles.
        guard let raw = defaults.string(forKey: "serverURL") else { return true }
        do {
            guard let bearer = try credentials.read("adminToken") else { return true }
            guard let server = AppSession.normalizedServerURL(raw) else { return false }
            try retireLegacySession(client: APIClient(baseURL: server, token: bearer, storeSlug: nil,
                                                       transport: recoveryTransport))
            return true
        } catch {
            Diagnostics.record("push_cleanup_error", ["message": "Legacy cleanup credential unavailable"])
            return false
        }
    }

    private func cleanupRegistrations() async -> Bool {
        var remaining: [Registration] = []
        for registration in registrations {
            do {
                let client: APIClient
                if let captured = registration.client { client = captured }
                else {
                    guard let bearer = try credentials.read(registration.receipt.credentialKey),
                          let server = AppSession.normalizedServerURL(registration.receipt.serverURLString),
                          server.absoluteString == registration.receipt.serverURLString else {
                        remaining.append(registration)
                        Diagnostics.record("push_cleanup_error", ["message": "Cleanup credential unavailable"])
                        continue
                    }
                    client = APIClient(baseURL: server, token: bearer, storeSlug: registration.receipt.storeSlug,
                                       transport: recoveryTransport)
                }
                do {
                    if registration.receipt.revokeSession == true {
                        let _: EmptyResponse = try await client.post("/v1/admin/logout")
                    } else if let deviceToken = registration.receipt.deviceToken {
                        let _: EmptyResponse = try await client.delete("/v1/admin/devices/\(deviceToken)")
                    } else {
                        throw APIError.invalidURL
                    }
                } catch {
                    // Revoked sessions cannot own registrations (server FK).
                    guard (error as? APIError)?.isUnauthorized == true else { throw error }
                }
                try credentials.remove(registration.receipt.credentialKey)
            } catch {
                remaining.append(registration)
                Diagnostics.record("push_cleanup_error", ["message": error.localizedDescription])
            }
        }
        registrations = remaining
        persistRegistrations()
        return remaining.isEmpty
    }

    private func persistRegistrations() {
        if let data = try? JSONEncoder().encode(registrations.map(\.receipt)) {
            defaults.set(data, forKey: Self.registrationsKey)
        }
    }

    func requestAuthorization() async { await device.requestAuthorization() }

    func didRegister(tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        registrar?(token, apnsEnvironment, "apns")
    }

    func didFailToRegister(error: Error) {
        Diagnostics.record("push_register_failed", ["message": error.localizedDescription])
    }

    func clearBadge() { UNUserNotificationCenter.current().setBadgeCount(0) { _ in } }

    private func observePushToStartToken(identity expectedIdentity: String) {
        pushToStartTask?.cancel()
        pushToStartTask = device.observeLiveActivityTokens { [weak self] token in
            guard let self, self.identity == expectedIdentity else { return }
            self.liveActivityToken = token
            self.registrar?(token, self.apnsEnvironment, "live_activity")
        }
    }

    func stopObservingPushToStart() {
        pushToStartTask?.cancel()
        pushToStartTask = nil
    }

    func endAllActivities() async { await device.endActivities() }

}

extension PushManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                           willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // Current payloads lack server/profile/store identity. Never present or
        // navigate an unscoped foreground notification into another merchant.
        []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                           didReceive response: UNNotificationResponse) async {
        // A tap opens the app only. Do not buffer/replay an orderCode without
        // verifiable origin: queued APNs deliveries can outlive a profile switch.
        Diagnostics.record("push_opened_unscoped")
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Task { @MainActor in PushManager.shared.configure() }
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushManager.shared.didRegister(tokenData: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushManager.shared.didFailToRegister(error: error) }
    }
}
