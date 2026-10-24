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

    @Environment(\.colorScheme) private var colorScheme

    private var brandGreen: Color {
        colorScheme == .dark ? Color(red: 69/255, green: 212/255, blue: 131/255) : Color(red: 22/255, green: 116/255, blue: 66/255)
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: focus == nil ? 22 : 10) {
                        Spacer(minLength: focus == nil ? 10 : 0)
                        VStack(spacing: focus == nil ? 11 : 4) {
                            Image("BrandMark").resizable().scaledToFit().frame(width: focus == nil ? 88 : 46, height: focus == nil ? 88 : 46)
                                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous)).accessibilityHidden(true)
                            (Text("Sell") + Text("Right").foregroundColor(brandGreen))
                                .font(.system(focus == nil ? .largeTitle : .title2, design: .rounded).weight(.bold))
                                .accessibilityElement(children: .ignore).accessibilityLabel("SellRight")
                            if focus == nil {
                                Text(challenge != nil ? "Enter the code for \(email) to continue." :
                                     addressAccepted ? "Sign in to \(acceptedHost)." :
                                     addingAccount ? "Connect another store account." :
                                     "Connect to your store's admin to manage orders, products, and more.")
                                    .font(.subheadline).foregroundStyle(palette.textMuted)
                                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).frame(maxWidth: 340)
                            }
                        }.frame(maxWidth: .infinity).padding(.bottom, focus == nil ? 3 : 0)

                        if let challenge { codeStep(challenge: challenge) }
                        else if addressAccepted { credentialForm }
                        else { serverForm }

                        if let message = errorMessage ?? session.profileError {
                            Label(message, systemImage: "exclamationmark.circle.fill").font(.subheadline).foregroundStyle(palette.danger)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                                .background(palette.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                                .accessibilityIdentifier("login.error")
                        }
                        primaryButton
                        profileSwitcher
                        Spacer(minLength: 10)
                    }
                    .frame(maxWidth: 420).frame(maxWidth: .infinity).frame(minHeight: geometry.size.height)
                    .padding(.horizontal, 24).padding(.vertical, focus == nil ? 16 : 6)
                }
                .scrollDismissesKeyboard(.interactively).background(palette.bg.ignoresSafeArea())
            }
            .tint(brandGreen)
            .navigationTitle("").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if addingAccount {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", role: .cancel) { cancel() }.accessibilityIdentifier("login.cancel")
                    }
                }
            }
            .animation(.default, value: challenge).interactiveDismissDisabled(busy)
            .onDisappear { if !loginSucceeded && switchingProfile == nil { session.cancelLogin() } }
            .onChange(of: session.activeProfileID) { _, id in
                guard let profile = session.profiles.first(where: { $0.id == id }) else { return }
                serverAddress = profile.serverURLString; email = profile.email; addressAccepted = false; resetCredentials()
            }
        }
    }

    private var serverForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Store server").font(.headline).foregroundStyle(palette.text)
            TextField("yourstore.com", text: $serverAddress)
                .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("login.serverAddress").accessibilityLabel("Store admin address").focused($focus, equals: .server).submitLabel(.continue).onSubmit(acceptAddress)
                .padding(14).background(palette.bg, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focus == .server ? brandGreen : palette.borderStrong, lineWidth: focus == .server ? 2 : 1))
            Text("Enter your store's admin address, for example yourstore.com.")
                .font(.footnote).foregroundStyle(palette.textMuted).fixedSize(horizontal: false, vertical: true)
        }.padding(18).background(palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(palette.border, lineWidth: 1))
    }

    private var credentialForm: some View {
        VStack(alignment: .leading, spacing: focus == nil ? 15 : 10) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Store").font(.caption.weight(.semibold)).foregroundStyle(palette.textMuted)
                    Text(acceptedHost).font(.subheadline.weight(.semibold)).foregroundStyle(palette.text).lineLimit(1).truncationMode(.middle)
                }
                Spacer()
                Button("Change") { returnToAddress() }.disabled(busy).accessibilityLabel("Change store address")
            }
            Divider().overlay(palette.border)
            VStack(alignment: .leading, spacing: 7) {
                Text("Email").font(.subheadline.weight(.semibold)).foregroundStyle(palette.text)
                TextField("name@example.com", text: $email).keyboardType(.emailAddress).textContentType(.username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("login.email")
                    .focused($focus, equals: .email).submitLabel(.next).onSubmit { focus = .password }
                    .padding(14).background(palette.bg, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focus == .email ? brandGreen : palette.borderStrong, lineWidth: focus == .email ? 2 : 1))
            }
            VStack(alignment: .leading, spacing: 7) {
                Text("Password").font(.subheadline.weight(.semibold)).foregroundStyle(palette.text)
                SecureField("Password", text: $password).textContentType(.password).accessibilityIdentifier("login.password")
                    .focused($focus, equals: .password).submitLabel(.go).onSubmit { Task { await submitPassword() } }
                    .padding(14).background(palette.bg, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focus == .password ? brandGreen : palette.borderStrong, lineWidth: focus == .password ? 2 : 1))
            }
        }.padding(18).background(palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(palette.border, lineWidth: 1))
    }

    @ViewBuilder
    private var profileSwitcher: some View {
        if challenge == nil, !addressAccepted, !session.profiles.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Saved accounts").font(.headline).foregroundStyle(palette.text)
                ForEach(session.profiles) { profile in
                    Button { Task { await activate(profile) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "building.2.crop.circle").font(.title3).foregroundStyle(brandGreen)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(profileTitle(profile)).font(.subheadline.weight(.semibold)).foregroundStyle(palette.text).lineLimit(1)
                                Text(profile.email).font(.caption).foregroundStyle(palette.textMuted).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                            if switchingProfile == profile.id { ProgressView() }
                            else { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(palette.textMuted) }
                        }.padding(14).background(palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.border, lineWidth: 1))
                    }.buttonStyle(.plain).disabled(busy || switchingProfile != nil)
                        .accessibilityIdentifier("login.profile.\(profile.id.uuidString)")
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func codeStep(challenge: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Two-factor authentication").font(.headline).foregroundStyle(palette.text)
            Text(usesRecovery ? "Recovery code" : "Authenticator code").font(.subheadline.weight(.semibold)).foregroundStyle(palette.text)
            TextField(usesRecovery ? "Enter recovery code" : "6-digit code", text: $code)
                .keyboardType(usesRecovery ? .asciiCapable : .numberPad).textContentType(.oneTimeCode)
                .textInputAutocapitalization(.never).autocorrectionDisabled().font(.title3.monospacedDigit())
                .accessibilityIdentifier("login.code").focused($focus, equals: .code)
                .onAppear { focus = .code }
                .onChange(of: code) { _, new in if !usesRecovery, new.count == 6, new.allSatisfy(\.isNumber) { Task { await submitCode() } } }
                .padding(14).background(palette.bg, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focus == .code ? brandGreen : palette.borderStrong, lineWidth: focus == .code ? 2 : 1))
            Text(usesRecovery ? "Enter one of the recovery codes you saved when you set up two-factor authentication." :
                 "Enter the code from your authenticator app for \(email).")
                .font(.footnote).foregroundStyle(palette.textMuted).fixedSize(horizontal: false, vertical: true)
            if methods.contains("recovery_code") {
                Button(usesRecovery ? "Use an authenticator code" : "Use a recovery code") { usesRecovery.toggle(); code = ""; focus = .code }.disabled(busy)
            }
            Button("Back to sign in", role: .cancel) { resetCredentials() }.disabled(busy)
        }.padding(18).background(palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(palette.border, lineWidth: 1))
    }

    private var primaryButton: some View {
        Button {
            if challenge != nil { Task { await submitCode() } }
            else if addressAccepted { Task { await submitPassword() } }
            else { acceptAddress() }
        } label: {
            let actionInk = colorScheme == .dark
                ? Color(red: 16/255, green: 26/255, blue: 20/255)
                : Color.white
            Group {
                if busy || switchingProfile != nil { ProgressView().tint(actionInk) }
                else { Text(challenge != nil ? "Verify" : addressAccepted ? "Sign in" : "Continue").foregroundStyle(actionInk) }
            }.frame(maxWidth: .infinity, minHeight: 32)
        }.glassProminentIfAvailable().controlSize(.large).disabled(busy || switchingProfile != nil || !canSubmit)
            .accessibilityIdentifier(challenge != nil ? "login.verify" : addressAccepted ? "login.signIn" : "login.continue")
    }

    private var canSubmit: Bool {
        if challenge != nil { return !code.trimmingCharacters(in: .whitespaces).isEmpty }
        if addressAccepted { return !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty }
        return !serverAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var acceptedHost: String { AppSession.normalizedServerURL(serverAddress)?.host() ?? serverAddress }

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
