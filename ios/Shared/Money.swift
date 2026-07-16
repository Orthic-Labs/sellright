import Foundation

/// Formats integer-cents amounts (the API's only money representation) into a
/// localized currency string. Never do float math on money — divide only at
/// the display boundary.
enum Money {
    static func format(cents: Int, currency: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        let amount = Decimal(cents) / 100
        return formatter.string(from: amount as NSDecimalNumber) ?? "\(currency) \(amount)"
    }

    /// Parses user input like "12.50" / "12,50" / "12" into cents. Rejects
    /// negatives and garbage; rounds to the cent.
    static func parseCents(_ text: String) -> Int? {
        let normalized = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard !normalized.isEmpty, let value = Decimal(string: normalized), value >= 0 else { return nil }
        var scaled = value * 100
        var rounded = Decimal()
        NSDecimalRound(&rounded, &scaled, 0, .plain)
        return (rounded as NSDecimalNumber).intValue
    }
}
