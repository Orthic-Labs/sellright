import SwiftUI

/// Store address comes first so credentials are never sent before an endpoint
/// has been accepted. Password and challenge state are discarded on every exit.
struct LoginView: View {
    @Environment(\.palette) private var palette
    @Environment(AppSession.self) private var session
    @Environment(\.dismiss) private var dismiss

    private enum Field: Hashable { case server, email, password, code }

    @State private var serverAddress: String
    @State private var addressAccepted = false
    @State private var email: String
    @State private var password = ""
    @State private var code = ""
    @State private var challenge: String?
    @State private var methods: [String] = []
    @State private var usesRecovery = false
    @State private var busy = false
    @State private var loginSucceeded = false
    @State private var switchingProfile: UUID?
    @State private var errorMessage: String?
    @FocusState private var focus: Field?

    private let addingAccount: Bool
    private let onSignedIn: (() -> Void)?
    private let onCancel: (() -> Void)?

    init(profile: StoreProfile? = nil, addingAccount: Bool = false, onSignedIn: (() -> Void)? = nil, onCancel: (() -> Void)? = nil) {
        _serverAddress = State(initialValue: profile?.serverURLString ?? "")
        _email = State(initialValue: profile?.email ?? "")
        self.addingAccount = addingAccount
        self.onSignedIn = onSignedIn
        self.onCancel = onCancel
    }

    var body: some View {
        NavigationStack {
            Form {
                if let challenge {
                    codeStep(challenge: challenge)
                } else if addressAccepted {
                    Section {
                        LabeledContent("Store", value: acceptedHost)
                        Button("Change store address", systemImage: "arrow.left") { returnToAddress() }
                            .disabled(busy)
                    } header: {
                        Text("Store server")
                    }
                    Section("Sign in") {
                        TextField("Email", text: $email)
                            .keyboardType(.emailAddress)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("login.email")
                            .focused($focus, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focus = .password }
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .accessibilityIdentifier("login.password")
                            .focused($focus, equals: .password)
                            .submitLabel(.go)
                            .onSubmit { Task { await submitPassword() } }
                    }
                } else {
                    Section {
                        TextField("yourstore.com", text: $serverAddress)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("login.serverAddress")
                            .focused($focus, equals: .server)
                            .submitLabel(.continue)
                            .onSubmit(acceptAddress)
                    } header: {
                        Text("Store server")
                    } footer: {
                        Text("Enter your store's admin address, for example yourstore.com.")
                    }
                    profileSwitcher
                }

                if let message = errorMessage ?? session.profileError {
                    Section {
                        Label(message, systemImage: "exclamationmark.circle")
                            .foregroundStyle(palette.danger)
                            .accessibilityIdentifier("login.error")
                    }
                }
            }
            .navigationTitle(challenge != nil ? "Verify it's you" : addingAccount ? "Add account" : "SellRight")
            .toolbar {
                if addingAccount {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", role: .cancel) { cancel() }
                            .accessibilityIdentifier("login.cancel")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { primaryButton }
            .animation(.default, value: challenge)
            .interactiveDismissDisabled(busy)
            .onDisappear {
                if !loginSucceeded && switchingProfile == nil { session.cancelLogin() }
            }
            .onChange(of: session.activeProfileID) { _, id in
                guard let profile = session.profiles.first(where: { $0.id == id }) else { return }
                serverAddress = profile.serverURLString
                email = profile.email
                addressAccepted = false
                resetCredentials()
            }
        }
    }

    @ViewBuilder
    private var profileSwitcher: some View {
        if !session.profiles.isEmpty {
            Section("Saved accounts") {
                ForEach(session.profiles) { profile in
                    Button {
                        Task { await activate(profile) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(profileTitle(profile)).foregroundStyle(palette.text)
                                Text(profile.email).font(.caption).foregroundStyle(palette.textMuted)
                            }
                            Spacer()
                            if switchingProfile == profile.id { ProgressView() }
                        }
                    }
                    .disabled(busy || switchingProfile != nil)
                    .accessibilityIdentifier("login.profile.\(profile.id.uuidString)")
                }
            }
        }
    }

    @ViewBuilder
    private func codeStep(challenge: String) -> some View {
        Section {
            TextField(usesRecovery ? "Recovery code" : "6-digit code", text: $code)
                .keyboardType(usesRecovery ? .asciiCapable : .numberPad)
                .textContentType(.oneTimeCode)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.title3.monospacedDigit())
                .accessibilityIdentifier("login.code")
                .focused($focus, equals: .code)
                .onAppear { focus = .code }
                .onChange(of: code) { _, new in
                    if !usesRecovery, new.count == 6, new.allSatisfy(\.isNumber) { Task { await submitCode() } }
                }
        } header: {
            Text("Two-factor authentication")
        } footer: {
            Text(usesRecovery
                ? "Enter one of the recovery codes you saved when you set up two-factor authentication."
                : "Enter the code from your authenticator app for \(email).")
        }
        Section {
            if methods.contains("recovery_code") {
                Button(usesRecovery ? "Use an authenticator code" : "Use a recovery code") {
                    usesRecovery.toggle()
                    code = ""
                    focus = .code
                }
                .disabled(busy)
            }
            Button("Back to sign in", role: .cancel) { resetCredentials() }
                .disabled(busy)
        }
    }

    private var primaryButton: some View {
        Button {
            if challenge != nil { Task { await submitCode() } }
            else if addressAccepted { Task { await submitPassword() } }
            else { acceptAddress() }
        } label: {
            Group {
                if busy || switchingProfile != nil { ProgressView() }
                else { Text(challenge != nil ? "Verify" : addressAccepted ? "Sign in" : "Continue") }
            }
            .frame(maxWidth: .infinity, minHeight: 32)
        }
        .glassProminentIfAvailable()
        .controlSize(.large)
        .disabled(busy || switchingProfile != nil || !canSubmit)
        .padding(.horizontal)
        .padding(.bottom, 8)
        .accessibilityIdentifier(challenge != nil ? "login.verify" : addressAccepted ? "login.signIn" : "login.continue")
    }

    private var canSubmit: Bool {
        if challenge != nil { return !code.trimmingCharacters(in: .whitespaces).isEmpty }
        if addressAccepted { return !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty }
        return !serverAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var acceptedHost: String {
        AppSession.normalizedServerURL(serverAddress)?.host() ?? serverAddress
    }

    private func acceptAddress() {
        guard let url = AppSession.normalizedServerURL(serverAddress) else {
            errorMessage = "Enter a valid store address, for example yourstore.com."
            return
        }
        serverAddress = url.absoluteString
        errorMessage = nil
        addressAccepted = true
        focus = email.isEmpty ? .email : .password
    }

    private func submitPassword() async {
        guard canSubmit, addressAccepted, !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            switch try await session.login(serverAddress: serverAddress, email: email, password: password) {
            case .signedIn:
                loginSucceeded = true
                password = ""
                onSignedIn?()
            case let .needsCode(token, available):
                methods = available
                usesRecovery = !available.contains("totp")
                challenge = token
            }
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    private func submitCode() async {
        guard let challenge, canSubmit, !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await session.completeLogin(challenge: challenge, code: code.trimmingCharacters(in: .whitespaces))
            loginSucceeded = true
            password = ""
            code = ""
            onSignedIn?()
        } catch {
            errorMessage = Self.message(for: error)
            code = ""
            if case let APIError.http(401, message) = error, message.contains("password again") { resetCredentials(keepError: true) }
        }
    }

    private func activate(_ profile: StoreProfile) async {
        switchingProfile = profile.id
        serverAddress = profile.serverURLString
        email = profile.email
        addressAccepted = false
        resetCredentials()
        errorMessage = nil
        defer { switchingProfile = nil }
        await session.switchProfile(id: profile.id)
        if session.phase == .loggedIn { loginSucceeded = true }
    }

    private func returnToAddress() {
        resetCredentials()
        addressAccepted = false
        focus = .server
    }

    private func resetCredentials(keepError: Bool = false) {
        session.cancelLogin()
        challenge = nil
        code = ""
        password = ""
        methods = []
        usesRecovery = false
        if !keepError { errorMessage = nil }
        focus = addressAccepted ? .password : .server
    }

    private func cancel() {
        resetCredentials()
        if let onCancel { onCancel() } else { dismiss() }
    }

    private func profileTitle(_ profile: StoreProfile) -> String {
        let host = AppSession.normalizedServerURL(profile.serverURLString)?.host() ?? profile.serverURLString
        return [profile.storeName, host].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func message(for error: Error) -> String {
        switch error {
        case let APIError.http(_, message): return message.prefix(1).uppercased() + message.dropFirst()
        case APIError.invalidURL: return "Enter a valid store address, for example yourstore.com."
        default: return error.localizedDescription
        }
    }
}

extension View {
    /// Liquid Glass prominent button on iOS 26+, the bordered-prominent style before it.
    @ViewBuilder
    func glassProminentIfAvailable() -> some View {
        if #available(iOS 26.0, *) {
            buttonStyle(.glassProminent)
        } else {
            buttonStyle(.borderedProminent)
        }
    }
}
