import XCTest
@testable import SellRightAdmin

final class ModelsTests: XCTestCase {
    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            if let date = fractional.date(from: s) ?? plain.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad date \(s)"))
        }
        return d
    }

    func testDashboardDecodes() throws {
        let json = """
        {
          "store": { "slug": "damned", "name": "Damned Designs", "currency": "USD" },
          "revenue": 1234500, "orders": 42, "aov": 29392,
          "pendingFulfillment": 3, "customers": 8200, "lowStock": 5,
          "recentOrders": [
            { "code": "DD-1001", "state": "Paid", "grandTotal": 15900, "currency": "USD",
              "placedAt": "2026-07-16T09:12:33.123Z", "email": "buyer@example.com" }
          ]
        }
        """.data(using: .utf8)!
        let d = try decoder().decode(Dashboard.self, from: json)
        XCTAssertEqual(d.orders, 42)
        XCTAssertEqual(d.recentOrders.first?.code, "DD-1001")
        XCTAssertNotNil(d.recentOrders.first?.placedAt)
    }

    func testOrdersPageDecodesWithNullPlacedAt() throws {
        let json = """
        { "items": [ { "code": "DD-9", "state": "Draft", "grandTotal": 0, "currency": "USD",
                       "placedAt": null, "createdAt": "2026-07-01T00:00:00.000Z", "email": null } ],
          "total": 1, "page": 1, "pageSize": 25 }
        """.data(using: .utf8)!
        let page = try decoder().decode(Page<OrderSummary>.self, from: json)
        XCTAssertEqual(page.items.count, 1)
        XCTAssertNil(page.items[0].placedAt)
    }

    func testOrderLineRefundMath() throws {
        let json = """
        { "id": "line-1", "sku": "SKU1", "name": "Knife", "quantity": 3,
          "unitPrice": 5000, "lineTotal": 15000, "fulfilledQty": 3, "refundedQty": 1 }
        """.data(using: .utf8)!
        let line = try decoder().decode(OrderLine.self, from: json)
        XCTAssertEqual(line.id, "line-1")
        XCTAssertEqual(line.refundableQty, 2)
        // Mirrors the server: round(lineTotal / quantity) * qty.
        XCTAssertEqual(line.refundAmount(for: 2), 10000)
        XCTAssertEqual(line.refundAmount(for: 0), 0)
    }

    func testMoneyParsesCents() {
        XCTAssertEqual(Money.parseCents("12.50"), 1250)
        XCTAssertEqual(Money.parseCents("12,50"), 1250)
        XCTAssertEqual(Money.parseCents("12"), 1200)
        XCTAssertNil(Money.parseCents("-5"))
        XCTAssertNil(Money.parseCents("abc"))
        XCTAssertNil(Money.parseCents(""))
    }

    func testMoneyFormatsCents() {
        // Locale-dependent symbols aside, the digits must reflect cents/100.
        let formatted = Money.format(cents: 15900, currency: "USD")
        XCTAssertTrue(formatted.contains("159"), "got \(formatted)")
    }
}
