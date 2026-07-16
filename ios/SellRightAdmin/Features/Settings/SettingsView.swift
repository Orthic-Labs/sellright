import SwiftUI

struct SettingsView: View {
    @Environment(AppSession.self) private var session

    var body: some View {
        @Bindable var session = session
        Form {
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
