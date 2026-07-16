import SwiftUI

struct LoginView: View {
    @Environment(\.palette) private var palette
    @Environment(AppSession.self) private var session

    @State private var email = ""
    @State private var password = ""
    @State private var totp = ""
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        @Bindable var session = session
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://api.yourstore.com", text: $session.serverURLString)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("Sign in") {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                    TextField("2FA code (if enabled)", text: $totp)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(palette.danger)
                    }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        if busy {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("Sign in").frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(busy || email.isEmpty || password.isEmpty)
                }
            }
            .navigationTitle("SellRight")
        }
    }

    private func submit() async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await session.login(email: email, password: password, totp: totp)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
