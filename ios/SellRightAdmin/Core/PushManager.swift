import ActivityKit
import Foundation
import UIKit
import UserNotifications

/// APNs registration + notification handling.
///
/// Flow: ask permission -> UIKit hands back a device token -> POST it to the
/// operator's own server (`/v1/admin/devices`), which is the only place it goes.
/// On logout the token is deleted server-side so a signed-out phone stops
/// receiving that store's orders.
@MainActor
final class PushManager: NSObject {
    static let shared = PushManager()

    /// Set by AppSession once signed in, so a token arriving from APNs (which is
    /// async and can land before or after login) knows where to register.
    var registrar: (@Sendable (String, String) async -> Void)?

    /// The last token APNs gave us. Kept so we can re-register on store switch
    /// and unregister on logout without waiting for a fresh callback.
    private(set) var deviceToken: String?

    /// Where a tapped notification's order code goes. AppSession owns the
    /// observable state (it's the @Observable the views already watch); this
    /// class stays a plain UIKit bridge with no observation machinery of its own.
    var onOrderOpened: (@MainActor (String) -> Void)?

    /// Holds the order code from a notification tapped before the UI existed
    /// (cold launch), until someone is listening.
    private var bufferedOrderCode: String?

    /// A Debug build signed with a development profile gets a SANDBOX token;
    /// TestFlight/App Store builds get production. Pushing a sandbox token to
    /// the production APNs host fails with BadDeviceToken and looks like
    /// "push is broken" — so the app reports which one it minted.
    var apnsEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    func configure() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// Ask for permission, then register with APNs. Safe to call on every launch:
    /// iOS only prompts once, and re-registering refreshes a rotated token.
    func requestAuthorization() async {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            Diagnostics.record("push_permission", ["granted": granted ? "true" : "false"])
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            Diagnostics.record("push_permission_error", ["message": error.localizedDescription])
        }
    }

    /// Called from the AppDelegate when APNs hands back a token.
    func didRegister(tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        Task { await registrar?(token, apnsEnvironment) }
    }

    func didFailToRegister(error: Error) {
        // Simulators (pre-iOS 16) and devices without a network path land here.
        // Not fatal: the app works, it just won't ding.
        Diagnostics.record("push_register_failed", ["message": error.localizedDescription])
    }

    /// Called once a listener attaches, to drain a cold-launch tap.
    func flushBufferedOrderCode() {
        guard let code = bufferedOrderCode, let handler = onOrderOpened else { return }
        bufferedOrderCode = nil
        handler(code)
    }

    fileprivate func handle(userInfo: [AnyHashable: Any]) {
        guard let code = userInfo["orderCode"] as? String else { return }
        Diagnostics.record("push_opened")
        if let handler = onOrderOpened {
            handler(code)
        } else {
            // Cold launch: the tap beat the UI. Buffer until RootView attaches.
            bufferedOrderCode = code
        }
    }

    /// Clear the app-icon badge. Called when the operator opens Orders — the
    /// badge means "orders you haven't looked at", so seeing the list clears it.
    func clearBadge() {
        UNUserNotificationCenter.current().setBadgeCount(0) { _ in }
    }

    // MARK: - Live Activity push-to-start

    private var pushToStartTask: Task<Void, Never>?

    /// Observe the push-to-start token and hand it to `registrar`. This token is
    /// distinct from the plain APNs device token: it authorizes the server to
    /// START a Live Activity on a device where the app isn't running, which is
    /// the only way a new order can light up the Island unprompted.
    ///
    /// The token rotates, so this is a long-lived async sequence, not a one-shot
    /// read. iOS 17.2+ only (the deployment target floor — see project.yml).
    func observePushToStartToken(register: @escaping @Sendable (String) async -> Void) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            // The operator disabled Live Activities in Settings. Notifications
            // still work; the Island just stays quiet.
            Diagnostics.record("live_activity_disabled")
            return
        }
        pushToStartTask?.cancel()
        pushToStartTask = Task {
            for await tokenData in Activity<OrderActivityAttributes>.pushToStartTokenUpdates {
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                await register(token)
            }
        }
    }

    func stopObservingPushToStart() {
        pushToStartTask?.cancel()
        pushToStartTask = nil
    }

    /// End every running order activity. Called on logout so a signed-out phone
    /// isn't left with a stale order pinned to its lock screen.
    func endAllActivities() async {
        for activity in Activity<OrderActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    /// Foreground presentation: still show the banner + play the sound. An
    /// operator staring at the dashboard should still notice a new order.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    /// Notification tapped — deep-link to the order it came from.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        await MainActor.run { PushManager.shared.handle(userInfo: userInfo) }
    }
}

/// UIKit bridge: SwiftUI has no hook for the APNs token callbacks, so the app
/// keeps a minimal AppDelegate purely to forward them.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Task { @MainActor in PushManager.shared.configure() }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in PushManager.shared.didRegister(tokenData: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in PushManager.shared.didFailToRegister(error: error) }
    }
}
