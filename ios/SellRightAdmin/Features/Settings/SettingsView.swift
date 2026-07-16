import SwiftUI

struct SettingsView: View {
    @Environment(AppSession.self) private var session
    @Environment(ThemeStore.self) private var theme

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
                LabeledContent("Server", value: session.serverURLString)
            }

            Section {
                Button("Sign out", role: .destructive) {
                    Task { await session.logout() }
                }
            }

            Section {
                LabeledContent("App", value: "SellRight Admin")
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")
            } footer: {
                Text("Runs against your own SellRight server. Diagnostics stay on-device (RightKit JSONL store, privacy-redacted).")
            }
        }
        .navigationTitle("Settings")
    }
}
