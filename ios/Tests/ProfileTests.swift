import Foundation
import XCTest
@testable import SellRightAdmin

@MainActor
private final class MemoryCredentials: SessionCredentialStore {
    var values: [String: String] = [:]
    var failWrites = false
    func read(_ key: String) throws -> String? { values[key] }
    func write(_ value: String, for key: String) throws {
        if failWrites { throw CocoaError(.fileWriteNoPermission) }
        values[key] = value
    }
    func remove(_ key: String) throws { values.removeValue(forKey: key) }
}

@MainActor
private final class SessionPushSpy: SessionPushManaging {
    var sessions: [(String?, APIClient?)] = []
    var revoked: [APIClient] = []
    func setSession(identity: String?, client: APIClient?) { sessions.append((identity, client)) }
    func revoke(client: APIClient) async { revoked.append(client) }
    func retireLegacySession(client: APIClient) throws { revoked.append(client) }
}

private actor ProfileServer {
    struct Request: Sendable {
        let method: String
        let path: String
        let host: String
        let token: String
        let store: String?
    }
    private struct Held {
        let url: URL
        let continuation: CheckedContinuation<(Data, URLResponse), Error>
    }
    private(set) var requests: [Request] = []
    private var heldKeys: Set<String> = []
    private var held: [String: Held] = [:]
    private var waiters: [String: CheckedContinuation<Void, Never>] = [:]
    private var sequence = 0
    var failCleanup = false
    var failLogout = false
    func setFailLogout(_ value: Bool) { failLogout = value }

    func setFailCleanup(_ value: Bool) { failCleanup = value }
    func hold(token: String, path: String) { heldKeys.insert(token + path) }
    func waitForPending(token: String, path: String) async {
        let key = token + path
        if held[key] != nil { return }
        await withCheckedContinuation { waiters[key] = $0 }
    }
    func release(token: String, path: String, status: Int, body: String) {
        let key = token + path
        guard let request = held.removeValue(forKey: key) else { return }
        heldKeys.remove(key)
        request.continuation.resume(returning: Self.response(url: request.url, status: status, body: body))
    }
    static func response(url: URL, status: Int = 200, body: String) -> (Data, URLResponse) {
        (Data(body.utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
    static let stores = #"[{"storeId":"store-one","slug":"one","name":"Store One","currency":"USD","role":"owner"},{"storeId":"store-two","slug":"two","name":"Store Two","currency":"USD","role":"manager"}]"#
    static func me(_ email: String) -> String { #"{"email":"\#(email)","stores":\#(stores)}"# }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let url = request.url!
        let token = request.value(forHTTPHeaderField: "Authorization")?.replacingOccurrences(of: "Bearer ", with: "") ?? ""
        let path = url.path()
        requests.append(Request(method: request.httpMethod ?? "GET", path: path, host: url.host()!, token: token,
                                store: request.value(forHTTPHeaderField: "x-store-slug")))
        XCTAssertFalse(request.httpShouldHandleCookies)
        let key = token + path
        if heldKeys.contains(key) {
            return try await withCheckedThrowingContinuation { continuation in
                held[key] = Held(url: url, continuation: continuation)
                waiters.removeValue(forKey: key)?.resume()
            }
        }
        if path == "/v1/admin/login" {
            let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as! [String: Any]
            let email = body["email"] as! String
            if body["password"] as? String == "bad" {
                return Self.response(url: url, status: 401, body: #"{"error":"Invalid credentials"}"#)
            }
            if body["password"] as? String == "2fa" {
                return Self.response(url: url, body: #"{"twoFactorRequired":true,"challengeToken":"challenge","methods":["totp"]}"#)
            }
            sequence += 1
            return Self.response(url: url, body: #"{"token":"\#(url.host()!)|\#(email)|\#(sequence)","admin":{"email":"\#(email)"},"stores":\#(Self.stores)}"#)
        }
        if path == "/v1/admin/me" {
            let email = token.split(separator: "|").dropFirst().first.map(String.init) ?? "legacy@example.com"
            return Self.response(url: url, body: Self.me(email))
        }
        if path == "/v1/admin/logout", failLogout { throw URLError(.notConnectedToInternet) }
        if request.httpMethod == "DELETE" {
            if failCleanup { throw URLError(.notConnectedToInternet) }
            return Self.response(url: url, body: #"{"ok":true}"#)
        }
        return Self.response(url: url, body: #"{"ok":true,"topics":["order.paid"]}"#)
    }
}

@MainActor
final class ProfileTests: XCTestCase {
    private func defaults() -> UserDefaults {
        UserDefaults(suiteName: "SellRight.ProfileTests.\(UUID().uuidString)")!
    }
    private func session(defaults: UserDefaults, credentials: MemoryCredentials, server: ProfileServer,
                         push: any SessionPushManaging = SessionPushSpy()) -> AppSession {
        AppSession(defaults: defaults, credentials: credentials, transport: { try await server.send($0) }, push: push)
    }
    private func signIn(_ session: AppSession, server: String = "merchant.example", email: String = "owner@example.com") async throws {
        _ = try await session.login(serverAddress: server, email: email, password: "password")
    }

    func testProfilesAreKeyedByCanonicalServerAndAccountWithoutPersistingTokens() async throws {
        let preferences = defaults(), credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: preferences, credentials: credentials, server: server)
        try await signIn(session)
        let first = try XCTUnwrap(session.activeProfileID)
        try await signIn(session, server: "https://MERCHANT.example:443/admin/")
        XCTAssertEqual(session.activeProfileID, first)
        XCTAssertEqual(session.profiles.count, 1)
        try await signIn(session, email: "second@example.com")
        try await signIn(session, server: "other.example")
        XCTAssertEqual(session.profiles.count, 3)
        XCTAssertEqual(Set(session.profiles.map(\.credentialKey)).count, 3)
        let metadata = try XCTUnwrap(preferences.data(forKey: AppSession.profilesKey))
        let metadataText = String(decoding: metadata, as: UTF8.self)
        for token in credentials.values.values { XCTAssertFalse(metadataText.contains(token)) }
        XCTAssertNil(preferences.string(forKey: "adminToken"))
    }

    func testStoreSelectionAndLastProfileSurviveRelaunch() async throws {
        let preferences = defaults(), credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: preferences, credentials: credentials, server: server)
        try await signIn(session)
        let first = try XCTUnwrap(session.activeProfileID)
        session.activeStore = session.stores[1]
        try await signIn(session, server: "other.example")
        let second = try XCTUnwrap(session.activeProfileID)
        XCTAssertEqual(session.activeStore?.slug, "one")
        await session.switchProfile(id: first)
        XCTAssertEqual(session.activeStore?.slug, "two")
        await session.switchProfile(id: second)
        let restored = self.session(defaults: preferences, credentials: credentials, server: server)
        await restored.bootstrap()
        XCTAssertEqual(restored.activeProfileID, second)
        XCTAssertEqual(restored.serverURLString, "https://other.example")
        await restored.switchProfile(id: first)
        XCTAssertEqual(restored.activeStore?.slug, "two")
    }

    func testSignoutRemovesOnlySelectedCredentialAndCapturesItsClient() async throws {
        let preferences = defaults(), credentials = MemoryCredentials(), server = ProfileServer(), push = SessionPushSpy()
        let session = session(defaults: preferences, credentials: credentials, server: server, push: push)
        try await signIn(session)
        let first = session.profiles[0]
        let firstToken = credentials.values[first.credentialKey]
        try await signIn(session, server: "other.example")
        let second = try XCTUnwrap(session.profiles.last)
        let secondToken = credentials.values[second.credentialKey]
        await session.logout()
        XCTAssertNil(credentials.values[second.credentialKey])
        XCTAssertEqual(credentials.values[first.credentialKey], firstToken)
        XCTAssertEqual(push.revoked.last?.token, secondToken)
        XCTAssertEqual(push.revoked.last?.baseURL.host(), "other.example")
        XCTAssertNil(session.admin)
        XCTAssertTrue(session.stores.isEmpty)
        await session.switchProfile(id: first.id)
        XCTAssertEqual(session.phase, .loggedIn)
    }

    func testUnauthenticatedLogin401DoesNotExpireActiveProfile() async throws {
        let credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: defaults(), credentials: credentials, server: server)
        try await signIn(session)
        let profile = session.profiles[0], identity = session.sessionIdentity
        do { _ = try await session.login(serverAddress: "other.example", email: "other@example.com", password: "bad"); XCTFail("Expected invalid password") }
        catch { XCTAssertTrue((error as? APIError)?.isUnauthorized == true) }
        XCTAssertEqual(session.activeProfileID, profile.id)
        XCTAssertEqual(session.phase, .loggedIn)
        XCTAssertEqual(session.sessionIdentity, identity)
        XCTAssertNotNil(credentials.values[profile.credentialKey])
    }

    func testLate401ExpiresOriginOnlyAndCannotExpireRenewedCredential() async throws {
        let credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: defaults(), credentials: credentials, server: server)
        try await signIn(session)
        let first = session.profiles[0], oldClient = session.api
        try await signIn(session, server: "other.example")
        await oldClient.onUnauthorized?()
        XCTAssertNil(credentials.values[first.credentialKey])
        XCTAssertEqual(session.serverURLString, "https://other.example")
        XCTAssertEqual(session.phase, .loggedIn)
        try await signIn(session)
        let renewed = credentials.values[first.credentialKey]
        await oldClient.onUnauthorized?()
        XCTAssertEqual(credentials.values[first.credentialKey], renewed)
        XCTAssertEqual(session.phase, .loggedIn)
    }

    func testSwitchClearsDataImmediatelyAndLateResponseCannotReplaceNewProfile() async throws {
        let credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: defaults(), credentials: credentials, server: server)
        try await signIn(session)
        let first = session.profiles[0]
        let firstToken = try XCTUnwrap(credentials.values[first.credentialKey])
        try await signIn(session, server: "other.example", email: "other@example.com")
        let second = try XCTUnwrap(session.activeProfileID)
        await server.hold(token: firstToken, path: "/v1/admin/me")
        let switching = Task { await session.switchProfile(id: first.id) }
        await server.waitForPending(token: firstToken, path: "/v1/admin/me")
        XCTAssertNil(session.admin)
        XCTAssertNil(session.activeStore)
        XCTAssertTrue(session.stores.isEmpty)
        XCTAssertEqual(session.phase, .loading)
        await session.switchProfile(id: second)
        let identity = session.sessionIdentity
        await server.release(token: firstToken, path: "/v1/admin/me", status: 200, body: ProfileServer.me(first.email))
        await switching.value
        XCTAssertEqual(session.admin?.email, "other@example.com")
        XCTAssertEqual(session.activeProfileID, second)
        XCTAssertEqual(session.sessionIdentity, identity)
    }

    func testActualLateHTTP401DoesNotInvalidateRenewedLogin() async throws {
        let credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: defaults(), credentials: credentials, server: server)
        try await signIn(session)
        let old = session.api, profile = session.profiles[0]
        await server.hold(token: old.token!, path: "/v1/admin/slow")
        let request = Task { () -> Bool in
            do { let _: EmptyResponse = try await old.get("/v1/admin/slow"); return false }
            catch { return (error as? APIError)?.isUnauthorized == true }
        }
        await server.waitForPending(token: old.token!, path: "/v1/admin/slow")
        try await signIn(session)
        let renewed = credentials.values[profile.credentialKey]
        await server.release(token: old.token!, path: "/v1/admin/slow", status: 401, body: #"{"error":"expired"}"#)
        let wasUnauthorized = await request.value
        XCTAssertTrue(wasUnauthorized)
        XCTAssertEqual(credentials.values[profile.credentialKey], renewed)
        XCTAssertEqual(session.phase, .loggedIn)
    }

    func testActiveHTTP401ClearsCurrentDataAndPreservesOtherProfile() async throws {
        let credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: defaults(), credentials: credentials, server: server)
        try await signIn(session, server: "other.example")
        let other = session.profiles[0], otherToken = credentials.values[session.profiles[0].credentialKey]
        try await signIn(session)
        let profile = try XCTUnwrap(session.profiles.last), client = session.api
        await server.hold(token: client.token!, path: "/v1/admin/slow")
        let request = Task {
            let _: EmptyResponse? = try? await client.get("/v1/admin/slow")
        }
        await server.waitForPending(token: client.token!, path: "/v1/admin/slow")
        session.pendingOrderCode = "OLD-ORDER"
        await server.release(token: client.token!, path: "/v1/admin/slow", status: 401, body: #"{"error":"expired"}"#)
        await request.value
        XCTAssertNil(credentials.values[profile.credentialKey])
        XCTAssertEqual(credentials.values[other.credentialKey], otherToken)
        XCTAssertNil(session.admin)
        XCTAssertNil(session.activeStore)
        XCTAssertNil(session.pendingOrderCode)
        XCTAssertEqual(session.phase, .loggedOut)
        XCTAssertTrue(session.profiles.last?.requiresLogin == true)
    }

    func testCanceledInFlightLoginCannotActivateMintedSession() async throws {
        let credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: defaults(), credentials: credentials, server: server)
        try await signIn(session)
        let original = session.activeProfileID
        await server.hold(token: "", path: "/v1/admin/login")
        let login = Task { () -> Bool in
            do { _ = try await session.login(serverAddress: "other.example", email: "other@example.com", password: "password"); return false }
            catch { return error is CancellationError }
        }
        await server.waitForPending(token: "", path: "/v1/admin/login")
        session.cancelLogin()
        await server.release(token: "", path: "/v1/admin/login", status: 200,
                             body: #"{"token":"canceled-token","admin":{"email":"other@example.com"},"stores":[]}"#)
        let wasCanceled = await login.value
        XCTAssertTrue(wasCanceled)
        XCTAssertEqual(session.activeProfileID, original)
        XCTAssertEqual(session.profiles.count, 1)
        XCTAssertFalse(credentials.values.values.contains("canceled-token"))
    }

    func testMigrationPersistsBeforeDeletingLegacyAndSecureWriteFailurePreservesLegacy() async throws {
        let preferences = defaults(), credentials = MemoryCredentials(), server = ProfileServer()
        preferences.set("merchant.example", forKey: "serverURL")
        preferences.set("two", forKey: "storeSlug")
        credentials.values["adminToken"] = "legacy-token"
        credentials.failWrites = true
        let transport: APIClient.Transport = { try await server.send($0) }
        let failingPush = PushManager(device: PushDeviceSpy(), defaults: preferences, credentials: credentials, recoveryTransport: transport)
        let failing = session(defaults: preferences, credentials: credentials, server: server, push: failingPush)
        await failing.bootstrap()
        XCTAssertTrue(failing.profiles.isEmpty)
        XCTAssertEqual(credentials.values["adminToken"], "legacy-token")
        XCTAssertEqual(preferences.string(forKey: "storeSlug"), "two")
        credentials.failWrites = false
        let migrationPush = PushManager(device: PushDeviceSpy(), defaults: preferences, credentials: credentials, recoveryTransport: transport)
        let migrated = session(defaults: preferences, credentials: credentials, server: server, push: migrationPush)
        await migrated.bootstrap()
        let profile = try XCTUnwrap(migrated.profiles.first)
        XCTAssertEqual(profile.email, "legacy@example.com")
        XCTAssertNil(credentials.values[profile.credentialKey])
        XCTAssertTrue(profile.requiresLogin)
        XCTAssertNil(credentials.values["adminToken"])
        XCTAssertNil(preferences.string(forKey: "serverURL"))
        XCTAssertEqual(profile.storeSlug, "two")
        XCTAssertEqual(migrated.phase, .loggedOut)
        await migrationPush.waitForPendingOperations()
        let requests = await server.requests
        XCTAssertTrue(requests.contains { $0.path == "/v1/admin/logout" && $0.token == "legacy-token" })
    }

    func testSecureWriteFailureCannotReplaceActiveSession() async throws {
        let credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: defaults(), credentials: credentials, server: server)
        try await signIn(session)
        let id = session.activeProfileID
        credentials.failWrites = true
        do { try await signIn(session, server: "other.example"); XCTFail("Expected Keychain failure") }
        catch { }
        XCTAssertEqual(session.activeProfileID, id)
        XCTAssertEqual(session.profiles.count, 1)
        XCTAssertEqual(session.phase, .loggedIn)
    }

    func testCanceledChallengeCannotChangeActiveProfile() async throws {
        let credentials = MemoryCredentials(), server = ProfileServer()
        let session = session(defaults: defaults(), credentials: credentials, server: server)
        try await signIn(session)
        let id = session.activeProfileID
        let result = try await session.login(serverAddress: "other.example", email: "other@example.com", password: "2fa")
        XCTAssertEqual(result, .needsCode(challenge: "challenge", methods: ["totp"]))
        XCTAssertEqual(session.activeProfileID, id)
        session.cancelLogin()
        do { try await session.completeLogin(challenge: "challenge", code: "123456"); XCTFail("Expected canceled challenge") }
        catch { }
        XCTAssertEqual(session.activeProfileID, id)
        XCTAssertEqual(session.phase, .loggedIn)
    }

    func testTransportFailureRetainsProfileForRetry() async throws {
        let credentials = MemoryCredentials(), server = ProfileServer(), preferences = defaults()
        let original = session(defaults: preferences, credentials: credentials, server: server)
        try await signIn(original)
        let profile = original.profiles[0], saved = credentials.values[original.profiles[0].credentialKey]
        let offline = AppSession(defaults: preferences, credentials: credentials,
                                 transport: { _ in throw URLError(.notConnectedToInternet) }, push: SessionPushSpy())
        await offline.bootstrap()
        XCTAssertEqual(credentials.values[profile.credentialKey], saved)
        XCTAssertEqual(offline.activeProfileID, profile.id)
        XCTAssertNotNil(offline.profileError)
        XCTAssertNil(offline.admin)
    }
}

@MainActor
private final class PushDeviceSpy: PushDevice {
    let environment = "sandbox"
    var cleared = 0
    var ended = 0
    var liveTokenHandler: (@MainActor (String) -> Void)?
    func requestAuthorization() async { }
    func clearNotifications() { cleared += 1 }
    func endActivities() async { ended += 1 }
    func observeLiveActivityTokens(_ handler: @escaping @MainActor (String) -> Void) -> Task<Void, Never>? {
        liveTokenHandler = handler
        return nil
    }
}

@MainActor
final class ProfilePushTests: XCTestCase {
    func testBothTokenKindsCleanUpWithOriginatingClientBeforeStoreReplacement() async throws {
        let server = ProfileServer(), device = PushDeviceSpy()
        let transport: APIClient.Transport = { try await server.send($0) }
        let push = PushManager(device: device, defaults: UserDefaults(suiteName: UUID().uuidString)!,
                               credentials: MemoryCredentials(), recoveryTransport: transport)
        let old = APIClient(baseURL: URL(string: "https://old.example")!, token: "old-session", storeSlug: "old-store", transport: transport)
        let next = APIClient(baseURL: URL(string: "https://new.example")!, token: "new-session", storeSlug: "new-store", transport: transport)
        push.didRegister(tokenData: Data([0x12, 0x34]))
        push.setSession(identity: "old", client: old)
        await push.waitForPendingOperations()
        let oldObserver = device.liveTokenHandler
        device.liveTokenHandler?("live-token")
        await push.waitForPendingOperations()
        push.setSession(identity: "new", client: next)
        oldObserver?("stale-observer-token")
        await push.waitForPendingOperations()
        let requests = await server.requests
        let deletions = requests.filter { $0.method == "DELETE" }
        XCTAssertEqual(Set(deletions.map(\.path)), ["/v1/admin/devices/1234", "/v1/admin/devices/live-token"])
        XCTAssertTrue(deletions.allSatisfy { $0.host == "old.example" && $0.token == "old-session" && $0.store == "old-store" })
        let lastDeletion = try XCTUnwrap(requests.lastIndex { $0.method == "DELETE" })
        let newRegistration = try XCTUnwrap(requests.firstIndex { $0.method == "POST" && $0.host == "new.example" })
        XCTAssertLessThan(lastDeletion, newRegistration)
        XCTAssertFalse(requests.contains { $0.path.contains("stale-observer-token") })
        XCTAssertGreaterThanOrEqual(device.cleared, 2)
        XCTAssertGreaterThanOrEqual(device.ended, 2)
    }

    func testRelaunchRestoresCleanupForBothTokenKindsWithoutPersistedBearers() async throws {
        let server = ProfileServer(), device = PushDeviceSpy(), credentials = MemoryCredentials()
        let preferences = UserDefaults(suiteName: UUID().uuidString)!
        let transport: APIClient.Transport = { try await server.send($0) }
        let old = APIClient(baseURL: URL(string: "https://old.example")!, token: "secret-old-bearer", storeSlug: "old-store", transport: transport)
        let next = APIClient(baseURL: URL(string: "https://new.example")!, token: "secret-new-bearer", storeSlug: "new-store", transport: transport)
        let original = PushManager(device: device, defaults: preferences, credentials: credentials, recoveryTransport: transport)
        original.didRegister(tokenData: Data([0x12, 0x34]))
        original.setSession(identity: "old", client: old)
        await original.waitForPendingOperations()
        device.liveTokenHandler?("live-token")
        await original.waitForPendingOperations()
        let receiptData = try XCTUnwrap(preferences.data(forKey: PushManager.registrationsKey))
        XCTAssertFalse(String(decoding: receiptData, as: UTF8.self).contains("secret-old-bearer"))
        XCTAssertEqual(credentials.values.count, 2)
        // Simulate process loss: restored owner has no APNs callback or live token.
        let restored = PushManager(device: PushDeviceSpy(), defaults: preferences, credentials: credentials, recoveryTransport: transport)
        restored.setSession(identity: "new", client: next)
        await restored.waitForPendingOperations()
        let requests = await server.requests
        let deletes = requests.filter { $0.method == "DELETE" }
        XCTAssertEqual(Set(deletes.map(\.path)), ["/v1/admin/devices/1234", "/v1/admin/devices/live-token"])
        XCTAssertTrue(deletes.allSatisfy { $0.host == "old.example" && $0.token == "secret-old-bearer" && $0.store == "old-store" })
        XCTAssertTrue(credentials.values.isEmpty)
        restored.didRegister(tokenData: Data([0x12, 0x34]))
        await restored.waitForPendingOperations()
        let afterToken = await server.requests
        XCTAssertEqual(afterToken.last?.host, "new.example")
        XCTAssertEqual(afterToken.last?.method, "POST")
    }

    func testLegacyWildcardRetirementSurvivesOfflineRelaunchAndBlocksReplacementPush() async throws {
        let server = ProfileServer(), credentials = MemoryCredentials()
        let preferences = UserDefaults(suiteName: UUID().uuidString)!
        preferences.set("https://legacy.example", forKey: "serverURL")
        credentials.values["adminToken"] = "legacy-secret"
        let transport: APIClient.Transport = { try await server.send($0) }
        let old = APIClient(baseURL: URL(string: "https://legacy.example")!, token: "legacy-secret", storeSlug: nil, transport: transport)
        let next = APIClient(baseURL: URL(string: "https://new.example")!, token: "new-secret", storeSlug: "new-store", transport: transport)
        let original = PushManager(device: PushDeviceSpy(), defaults: preferences, credentials: credentials, recoveryTransport: transport)
        try original.retireLegacySession(client: old)
        // The old profile credential can now go: its independent secure receipt survives.
        credentials.values.removeValue(forKey: "adminToken")
        preferences.removeObject(forKey: "serverURL")
        await server.setFailLogout(true)
        let restored = PushManager(device: PushDeviceSpy(), defaults: preferences, credentials: credentials, recoveryTransport: transport)
        restored.didRegister(tokenData: Data([0x12]))
        restored.setSession(identity: "next", client: next)
        await restored.waitForPendingOperations()
        let blocked = await server.requests
        XCTAssertTrue(blocked.contains { $0.path == "/v1/admin/logout" && $0.token == "legacy-secret" })
        XCTAssertFalse(blocked.contains { $0.host == "new.example" })
        let persisted = try XCTUnwrap(preferences.data(forKey: PushManager.registrationsKey))
        XCTAssertFalse(String(decoding: persisted, as: UTF8.self).contains("legacy-secret"))
        await server.setFailLogout(false)
        let retried = PushManager(device: PushDeviceSpy(), defaults: preferences, credentials: credentials, recoveryTransport: transport)
        retried.didRegister(tokenData: Data([0x12]))
        retried.setSession(identity: "next-retry", client: next)
        await retried.waitForPendingOperations()
        let requests = await server.requests
        XCTAssertEqual(requests.last?.host, "new.example")
        let lastLogout = try XCTUnwrap(requests.lastIndex { $0.path == "/v1/admin/logout" })
        let firstNew = try XCTUnwrap(requests.firstIndex { $0.host == "new.example" })
        XCTAssertLessThan(lastLogout, firstNew)
    }

    func testSwitchWaitsForInFlightOldRegistrationBeforeCleaningAndReplacingIt() async throws {
        let server = ProfileServer(), device = PushDeviceSpy()
        let transport: APIClient.Transport = { try await server.send($0) }
        let push = PushManager(device: device, defaults: UserDefaults(suiteName: UUID().uuidString)!,
                               credentials: MemoryCredentials(), recoveryTransport: transport)
        let old = APIClient(baseURL: URL(string: "https://same.example")!, token: "old-session", storeSlug: "one", transport: transport)
        let next = APIClient(baseURL: URL(string: "https://same.example")!, token: "new-session", storeSlug: "two", transport: transport)
        push.didRegister(tokenData: Data([0x12]))
        await server.hold(token: "old-session", path: "/v1/admin/devices")
        push.setSession(identity: "old", client: old)
        await server.waitForPending(token: "old-session", path: "/v1/admin/devices")
        push.setSession(identity: "new", client: next)
        await server.release(token: "old-session", path: "/v1/admin/devices", status: 200,
                             body: #"{"ok":true,"topics":["order.paid"]}"#)
        await push.waitForPendingOperations()
        let requests = await server.requests
        XCTAssertEqual(requests.map(\.method), ["POST", "DELETE", "POST"])
        XCTAssertEqual(requests.map(\.token), ["old-session", "old-session", "new-session"])
        XCTAssertEqual(requests.map(\.store), ["one", "one", "two"])
    }

    func testUncertainCleanupBlocksReplacementRegistration() async throws {
        let server = ProfileServer()
        let transport: APIClient.Transport = { try await server.send($0) }
        let push = PushManager(device: PushDeviceSpy(), defaults: UserDefaults(suiteName: UUID().uuidString)!,
                               credentials: MemoryCredentials(), recoveryTransport: transport)
        let old = APIClient(baseURL: URL(string: "https://old.example")!, token: "old", storeSlug: "one", transport: transport)
        let next = APIClient(baseURL: URL(string: "https://new.example")!, token: "new", storeSlug: "two", transport: transport)
        push.didRegister(tokenData: Data([0x12]))
        push.setSession(identity: "old", client: old)
        await push.waitForPendingOperations()
        await server.setFailCleanup(true)
        push.setSession(identity: "new", client: next)
        await push.waitForPendingOperations()
        let blocked = await server.requests
        XCTAssertFalse(blocked.contains { $0.host == "new.example" })
        await server.setFailCleanup(false)
        push.setSession(identity: "new-retry", client: next)
        await push.waitForPendingOperations()
        let retried = await server.requests
        XCTAssertTrue(retried.contains { $0.host == "new.example" && $0.method == "POST" })
    }
}
