import SwiftUI

/// Two-step sign-in (#333): email + password first; the code step appears only
/// after the password verified, and only for an account with a second factor.
struct LoginView: View {
    @Environment(\.palette) private var palette
    @Environment(AppSession.self) private var session

    private enum Field: Hashable { case server, email, password, code }

    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var challenge: String?
    @State private var methods: [String] = []
    @State private var busy = false
    @State private var errorMessage: String?
    @FocusState private var focus: Field?

    var body: some View {
        @Bindable var session = session
        NavigationStack {
            Form {
                if let challenge {
                    codeStep(challenge: challenge)
                } else {
                    Section {
                        TextField("yourstore.com", text: $session.serverURLString)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .server)
                            .submitLabel(.next)
                            .onSubmit { focus = .email }
                    } header: {
                        Text("Store server")
                    } footer: {
                        Text("The address of your store's admin, for example yourstore.com.")
                    }
                    Section("Sign in") {
                        TextField("Email", text: $email)
                            .keyboardType(.emailAddress)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focus = .password }
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .focused($focus, equals: .password)
                            .submitLabel(.go)
                            .onSubmit { Task { await submitPassword() } }
                    }
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.circle")
                            .foregroundStyle(palette.danger)
                    }
                }
            }
            .navigationTitle(challenge == nil ? "SellRight" : "Verify it's you")
            .safeAreaInset(edge: .bottom) { primaryButton }
            .animation(.default, value: challenge)
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
                .focused($focus, equals: .code)
                .onAppear { focus = .code }
                .onChange(of: code) { _, new in
                    // Auto-submit a complete authenticator code.
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
            }
            Button("Back to sign in", role: .cancel) { reset() }
        }
    }

    @State private var usesRecovery = false

    private var primaryButton: some View {
        Button {
            Task { challenge == nil ? await submitPassword() : await submitCode() }
        } label: {
            Group {
                if busy { ProgressView() } else { Text(challenge == nil ? "Sign in" : "Verify") }
            }
            .frame(maxWidth: .infinity, minHeight: 32)
        }
        .glassProminentIfAvailable()
        .controlSize(.large)
        .disabled(busy || !canSubmit)
        .padding(.horizontal)
        .padding(.bottom, 8)
    }

    private var canSubmit: Bool {
        if challenge != nil { return !code.trimmingCharacters(in: .whitespaces).isEmpty }
        return !email.isEmpty && !password.isEmpty && !session.serverURLString.isEmpty
    }

    private func submitPassword() async {
        guard canSubmit, !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            switch try await session.login(email: email, password: password) {
            case .signedIn:
                password = ""
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
            password = ""
        } catch {
            errorMessage = Self.message(for: error)
            code = ""
            // An expired or exhausted challenge needs the password again.
            if case let APIError.http(401, message) = error, message.contains("password again") { reset(keepError: true) }
        }
    }

    private func reset(keepError: Bool = false) {
        challenge = nil
        code = ""
        password = ""
        usesRecovery = false
        if !keepError { errorMessage = nil }
        focus = .password
    }

    /// The server's own sentence, without the transport detail.
    static func message(for error: Error) -> String {
        switch error {
        case let APIError.http(_, message): return message.prefix(1).uppercased() + message.dropFirst()
        case APIError.invalidURL: return "Enter your store's address, for example yourstore.com."
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
