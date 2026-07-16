import Foundation
import RightKitDiagnostics

/// App-level diagnostics on the shared RightKit JSONL store. Values pass
/// through PrivacyRedactor so emails/tokens never land in the log file.
enum Diagnostics {
    private static let store: JSONLDiagnosticStore = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return JSONLDiagnosticStore(fileURL: dir.appending(path: "diagnostics.jsonl"))
    }()

    private static let redactor = PrivacyRedactor()

    static func record(_ name: String, _ fields: [String: String] = [:]) {
        let redacted = fields.mapValues { redactor.redact($0) }
        _ = store.record(DiagnosticEvent(name: name, fields: redacted))
    }
}
