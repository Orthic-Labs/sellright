import Foundation
import Observation

@MainActor
@Observable
final class AppSession {
    enum Phase: Equatable { case loading, loggedOut, loggedIn }
    enum LoginStep: Equatable {
        case signedIn
        case needsCode(challenge: String, methods: [String])
    }

    private(set) var phase: Phase = .loading
    private(set) var admin: AdminIdentity?
    private(set) var stores: [StoreAccess] = []
    private(set) var profiles: [StoreProfile] = []
    private(set) var activeProfileID: UUID?
    private(set) var serverURLString = ""
    private(set) var profileError: String?
    private var identityGeneration = UUID()
    var sessionIdentity: String {
        "\(identityGeneration.uuidString)|\(activeProfileID?.uuidString ?? "")|\(activeStore?.slug ?? "")"
    }
    var pendingOrderCode: String?
    var activeStore: StoreAccess? {
        didSet {
            guard !applyingStore, oldValue?.slug != activeStore?.slug else { return }
            // Store identity changes replace every feature view, including its tasks.
            identityGeneration = UUID()
            pendingOrderCode = nil
            saveSelectedStore()
            configurePush()
        }
    }
    var canWrite: Bool { StoreAccess.canWrite(role: activeStore?.role) }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let credentials: any SessionCredentialStore
    @ObservationIgnored private let transport: APIClient.Transport?
    @ObservationIgnored private let push: any SessionPushManaging
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var revisions: [UUID: UUID] = [:]
    @ObservationIgnored private var activation = UUID()
    @ObservationIgnored private var loginAttempt = UUID()
    @ObservationIgnored private var pendingLogin: PendingLogin?
    @ObservationIgnored private var applyingStore = false
    private struct PendingLogin {
        let attempt: UUID
        let server: URL
        let challenge: String
    }

    static let profilesKey = "storeProfiles.v1"
    static let activeProfileKey = "activeStoreProfile.v1"

    init(defaults: UserDefaults = .standard,
         credentials: any SessionCredentialStore = KeychainCredentials(),
         transport: APIClient.Transport? = nil,
         push: any SessionPushManaging = PushManager.shared) {
        self.defaults = defaults
        self.credentials = credentials
        self.transport = transport
        self.push = push
        if let data = defaults.data(forKey: Self.profilesKey) {
            do { profiles = try JSONDecoder().decode([StoreProfile].self, from: data) }
            catch { profileError = "Saved accounts could not be read. Sign in again." }
        }
        for profile in profiles { revisions[profile.id] = UUID() }
    }

    var api: APIClient {
        var client = makeClient(server: serverURLString, token: token, storeSlug: activeStore?.slug)
        if let id = activeProfileID, let token, let revision = revisions[id] {
            client.onUnauthorized = { [weak self] in
                await self?.invalidateProfile(id: id, token: token, revision: revision)
            }
        }
        return client
    }

    private func makeClient(server: String, token: String?, storeSlug: String? = nil) -> APIClient {
        APIClient(baseURL: URL(string: server) ?? URL(filePath: "/"), token: token,
                  storeSlug: storeSlug, transport: transport)
    }

    func bootstrap() async {
        #if DEBUG
        if Demo.isOn {
            resetActiveState()
            serverURLString = Demo.serverURL
            token = Demo.token
            let identity = activation
            if let me: MeResponse = try? await api.get("/v1/admin/me"), identity == activation {
                apply(admin: me.admin, stores: me.stores)
            }
            return
        }
        #endif
        guard phase == .loading, activeProfileID == nil else { return }
        let bootstrapIdentity = activation
        let bootstrapLogin = loginAttempt
        if profiles.isEmpty { await migrateLegacySession() }
        guard activeProfileID == nil, activation == bootstrapIdentity, loginAttempt == bootstrapLogin else { return }
        let last = defaults.string(forKey: Self.activeProfileKey).flatMap(UUID.init(uuidString:))
        if let id = profiles.first(where: { $0.id == last })?.id ?? profiles.first?.id {
            await switchProfile(id: id)
        } else {
            phase = .loggedOut
        }
    }

    func login(serverAddress: String, email: String, password: String) async throws -> LoginStep {
        guard let server = Self.normalizedServerURL(serverAddress) else { throw APIError.invalidURL }
        cancelLogin()
        let attempt = loginAttempt
        let client = makeClient(server: server.absoluteString, token: nil)
        let response: LoginResponse = try await client.post("/v1/admin/login", body: LoginRequest(email: email, password: password))
        guard attempt == loginAttempt else { throw CancellationError() }
        if response.twoFactorRequired == true, let challenge = response.challengeToken {
            pendingLogin = PendingLogin(attempt: attempt, server: server, challenge: challenge)
            return .needsCode(challenge: challenge, methods: response.methods ?? ["totp", "recovery_code"])
        }
        try finishLogin(response, server: server)
        return .signedIn
    }

    func completeLogin(challenge: String, code: String) async throws {
        guard let draft = pendingLogin, draft.challenge == challenge, draft.attempt == loginAttempt else {
            throw APIError.http(status: 401, message: "Sign-in expired. Start again.")
        }
        let client = makeClient(server: draft.server.absoluteString, token: nil)
        let response: LoginResponse = try await client.post("/v1/admin/login/2fa", body: LoginSecondStepRequest(challengeToken: challenge, code: code))
        guard draft.attempt == loginAttempt else { throw CancellationError() }
        try finishLogin(response, server: draft.server)
    }

    func cancelLogin() {
        loginAttempt = UUID()
        pendingLogin = nil
    }

    private func finishLogin(_ response: LoginResponse, server: URL) throws {
        guard let newToken = response.token, !newToken.isEmpty, let admin = response.admin else {
            throw APIError.http(status: 401, message: "Sign-in did not complete. Try again.")
        }
        let email = admin.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var profile = profiles.first { $0.serverURLString == server.absoluteString && $0.email == email }
            ?? StoreProfile(id: UUID(), serverURLString: server.absoluteString, email: email)
        // Persist before changing either the saved profile or current session.
        try credentials.write(newToken, for: profile.credentialKey)
        profile.requiresLogin = false
        upsert(profile)
        revisions[profile.id] = UUID()
        cancelLogin()
        resetActiveState()
        activeProfileID = profile.id
        serverURLString = profile.serverURLString
        token = newToken
        defaults.set(profile.id.uuidString, forKey: Self.activeProfileKey)
        apply(admin: admin, stores: response.stores ?? [])
        Diagnostics.record("login", ["server": serverURLString])
    }

    func switchProfile(id: UUID) async {
        guard let profile = profiles.first(where: { $0.id == id }) else { return }
        cancelLogin()
        resetActiveState()
        activeProfileID = id
        serverURLString = profile.serverURLString
        defaults.set(id.uuidString, forKey: Self.activeProfileKey)
        let identity = activation
        guard !profile.requiresLogin else {
            phase = .loggedOut
            profileError = "Sign in to reconnect this account."
            return
        }
        do {
            guard let stored = try credentials.read(profile.credentialKey), !stored.isEmpty else {
                phase = .loggedOut
                return
            }
            token = stored
            let me: MeResponse = try await api.get("/v1/admin/me")
            guard activation == identity, activeProfileID == id else { return }
            // Never silently rebind saved metadata to a different server account.
            guard me.email.lowercased() == profile.email.lowercased() else {
                invalidateProfile(id: id, token: stored, revision: revisions[id])
                return
            }
            apply(admin: me.admin, stores: me.stores)
        } catch {
            guard activation == identity, activeProfileID == id else { return }
            token = nil
            phase = .loggedOut
            profileError = error.localizedDescription
            // Transport/decoding failures keep saved credentials for retry.
        }
    }

    func logout() async {
        guard let id = activeProfileID, var profile = profiles.first(where: { $0.id == id }) else {
            cancelLogin()
            resetActiveState()
            phase = .loggedOut
            return
        }
        let client = api
        cancelLogin()
        profile.requiresLogin = true
        upsert(profile)
        revisions[id] = UUID()
        resetActiveState()
        activeProfileID = id
        serverURLString = profile.serverURLString
        phase = .loggedOut
        do { try credentials.remove(profile.credentialKey) }
        catch { profileError = "Sign-out saved; credential cleanup failed: \(error.localizedDescription)" }
        // This is queued behind every old registration & cleanup, before revocation.
        await push.revoke(client: client)
    }

    private func invalidateProfile(id: UUID, token requestToken: String, revision: UUID?) {
        guard let revision, revisions[id] == revision,
              var profile = profiles.first(where: { $0.id == id }),
              (try? credentials.read(profile.credentialKey)) == requestToken else { return }
        revisions[id] = UUID()
        profile.requiresLogin = true
        upsert(profile)
        do { try credentials.remove(profile.credentialKey) }
        catch { profileError = "Session expired; credential cleanup failed." }
        guard activeProfileID == id else { return }
        resetActiveState()
        activeProfileID = id
        serverURLString = profile.serverURLString
        phase = .loggedOut
        profileError = "Session expired. Sign in again."
    }

    private func resetActiveState() {
        activation = UUID()
        identityGeneration = UUID()
        push.setSession(identity: nil, client: nil)
        token = nil
        admin = nil
        stores = []
        applyingStore = true
        activeStore = nil
        applyingStore = false
        pendingOrderCode = nil
        activeProfileID = nil
        serverURLString = ""
        profileError = nil
        phase = .loading
    }

    private func apply(admin: AdminIdentity, stores: [StoreAccess]) {
        self.admin = admin
        self.stores = stores
        let last = profiles.first(where: { $0.id == activeProfileID })?.storeSlug
        applyingStore = true
        activeStore = stores.first(where: { $0.slug == last }) ?? stores.first
        applyingStore = false
        phase = .loggedIn
        saveSelectedStore()
        configurePush()
    }

    private func saveSelectedStore() {
        guard let id = activeProfileID, let index = profiles.firstIndex(where: { $0.id == id }) else { return }
        profiles[index].storeSlug = activeStore?.slug
        profiles[index].storeName = activeStore?.name
        persistProfiles()
    }

    private func configurePush() {
        #if DEBUG
        if Demo.isOn { return }
        #endif
        guard phase == .loggedIn, activeStore != nil else {
            push.setSession(identity: nil, client: nil)
            return
        }
        push.setSession(identity: sessionIdentity, client: api)
    }

    private func upsert(_ profile: StoreProfile) {
        if let index = profiles.firstIndex(where: { $0.id == profile.id }) { profiles[index] = profile }
        else { profiles.append(profile) }
        persistProfiles()
    }

    private func persistProfiles() {
        // StoreProfile contains metadata only; never encode APIClient or credentials.
        if let data = try? JSONEncoder().encode(profiles) { defaults.set(data, forKey: Self.profilesKey) }
    }

    private func migrateLegacySession() async {
        guard let raw = defaults.string(forKey: "serverURL"), let server = Self.normalizedServerURL(raw) else { return }
        let identity = activation
        let attempt = loginAttempt
        do {
            guard let legacyToken = try credentials.read("adminToken") else { return }
            let client = makeClient(server: server.absoluteString, token: legacyToken)
            // Old builds persisted no device tokens: preserve a secure revocation
            // receipt before any network await, then require a fresh sign-in.
            try push.retireLegacySession(client: client)
            let me: MeResponse = try await client.get("/v1/admin/me")
            guard identity == activation, attempt == loginAttempt, profiles.isEmpty else { return }
            let profile = StoreProfile(id: UUID(), serverURLString: server.absoluteString,
                                       email: me.email.lowercased(), storeSlug: defaults.string(forKey: "storeSlug"),
                                       requiresLogin: true)
            upsert(profile)
            revisions[profile.id] = UUID()
            defaults.set(profile.id.uuidString, forKey: Self.activeProfileKey)
            // The durable receipt now owns old-session cleanup. Never restore
            // its bearer into a profile: unknown pre-upgrade devices must retire.
            try credentials.remove("adminToken")
            defaults.removeObject(forKey: "serverURL")
            defaults.removeObject(forKey: "storeSlug")
            profileError = "Account upgraded. Sign in again to reconnect notifications."
        } catch {
            guard identity == activation else { return }
            profileError = "Saved sign-in could not be restored: \(error.localizedDescription)"
        }
        // Failed/offline revocation remains persisted & blocks replacement push.
        push.setSession(identity: nil, client: nil)
    }

    /// HTTPS for merchants; HTTP only for explicit loopback/private development hosts.
    static func normalizedServerURL(_ raw: String) -> URL? {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        guard !value.isEmpty else { return nil }
        if !value.contains("://") { value = "https://" + value }
        guard var parts = URLComponents(string: value), let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              !host.hasPrefix("."), !host.hasSuffix("."), !host.contains("..") else { return nil }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        let octets = labels.compactMap { Int($0) }
        let decimalLabels = labels.allSatisfy { !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } }
        let privateIPv4 = labels.count == 4 && octets.count == 4 && decimalLabels && octets.allSatisfy { (0...255).contains($0) }
            && (octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 172 && (16...31).contains(octets[1])))
        let local = host == "localhost" || host == "[::1]" || host == "::1" || host.hasSuffix(".local") || privateIPv4
        guard scheme == "https" || (scheme == "http" && local) else { return nil }
        // Store addresses name an origin: pasted /admin paths never prefix /v1 routes.
        parts.path = ""
        parts.scheme = scheme
        parts.host = host
        if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) { parts.port = nil }
        return parts.url
    }
}
