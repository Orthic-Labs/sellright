import SwiftUI

struct SettingsView: View {
    @Environment(AppSession.self) private var session
    @Environment(ThemeStore.self) private var theme
    @Environment(\.palette) private var palette

    @State private var showingAddAccount = false
    @State private var switchingProfile: UUID?
    @State private var retryProfileID: UUID?

    var body: some View {
        @Bindable var session = session
        @Bindable var theme = theme
        Form {
            Section("Appearance") {
                Picker("Theme", selection: $theme.name) {
                    ForEach(ThemeName.allCases) { Text($0.label).tag($0) }
                }
                Picker("Mode", selection: $theme.mode) {
                    ForEach(ThemeMode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
            }

            if session.profiles.count > 1 {
                Section("Accounts") {
                    ForEach(session.profiles) { profile in
                        Button {
                            Task { await switchTo(profile) }
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(profileTitle(profile))
                                        .foregroundStyle(palette.text)
                                    Text(profile.email)
                                        .font(.caption)
                                        .foregroundStyle(palette.textMuted)
                                }
                                Spacer()
                                if session.activeProfileID == profile.id {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(palette.accent)
                                        .accessibilityLabel("Active account")
                                } else if switchingProfile == profile.id {
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(switchingProfile != nil || session.activeProfileID == profile.id)
                        .accessibilityIdentifier("settings.profile.\(profile.id.uuidString)")
                    }
                    Button("Add account", systemImage: "plus") { showingAddAccount = true }
                        .accessibilityIdentifier("settings.addAccount")
                }
            } else {
                Section("Accounts") {
                    Button("Add account", systemImage: "plus") { showingAddAccount = true }
                        .accessibilityIdentifier("settings.addAccount")
                }
            }

            if let message = session.profileError {
                Section {
                    Label(message, systemImage: "exclamationmark.circle")
                        .foregroundStyle(palette.danger)
                    if let profile = session.profiles.first(where: { $0.id == retryProfileID }) {
                        Button("Retry account", systemImage: "arrow.clockwise") {
                            Task { await switchTo(profile) }
                        }
                        .disabled(switchingProfile != nil)
                    }
                }
            }

            if session.stores.count > 1 {
                Section("Store") {
                    Picker("Active store", selection: $session.activeStore) {
                        ForEach(session.stores) { store in
                            Text(store.name).tag(StoreAccess?.some(store))
                        }
                    }
                }
            }

            Section("Account") {
                if let admin = session.admin {
                    LabeledContent("Signed in as", value: admin.email)
                }
                if let store = session.activeStore {
                    LabeledContent("Role", value: store.role)
                    LabeledContent("Currency", value: store.currency)
                }
                LabeledContent("Server", value: activeHost)
            }

            Section {
                Button("Sign out", role: .destructive) {
                    Task { await session.logout() }
                }
                .accessibilityIdentifier("settings.signOut")
            } footer: {
                Text("Signs out of this account on this device.")
            }

            Section {
                LabeledContent("App", value: "SellRight Admin")
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")
            } footer: {
                Text("Runs against your own SellRight server. Diagnostics stay on-device (RightKit JSONL store, privacy-redacted).")
            }
        }
        .navigationTitle("Settings")
        .sheet(isPresented: $showingAddAccount) {
            LoginView(addingAccount: true, onSignedIn: { showingAddAccount = false }, onCancel: { showingAddAccount = false })
        }
    }

    private var activeHost: String {
        AppSession.normalizedServerURL(session.serverURLString)?.host() ?? session.serverURLString
    }

    private func profileTitle(_ profile: StoreProfile) -> String {
        let host = AppSession.normalizedServerURL(profile.serverURLString)?.host() ?? profile.serverURLString
        return [profile.storeName, host].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func switchTo(_ profile: StoreProfile) async {
        switchingProfile = profile.id
        retryProfileID = profile.id
        defer { switchingProfile = nil }
        await session.switchProfile(id: profile.id)
        if session.profileError == nil { retryProfileID = nil }
    }
}
