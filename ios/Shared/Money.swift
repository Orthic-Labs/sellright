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

    /// Space-constrained variant for the Dynamic Island compact region, where a
    /// full "$1,299.00" doesn't fit: drops the decimals, and abbreviates past
    /// four figures ("$1.3k").
    static func compact(cents: Int, currency: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        formatter.maximumFractionDigits = 0
        let units = Decimal(cents) / 100

        if units >= 1000 {
            formatter.maximumFractionDigits = 1
            let thousands = units / 1000
            let base = formatter.string(from: thousands as NSDecimalNumber) ?? "\(thousands)"
            return "\(base)k"
        }
        return formatter.string(from: units as NSDecimalNumber) ?? "\(currency) \(units)"
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
