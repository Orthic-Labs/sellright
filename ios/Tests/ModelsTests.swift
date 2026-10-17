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

    func testMeDecodesActualTopLevelIdentityContract() throws {
        let json = """
        { "email": "operator@example.com", "isInstallationAdmin": false,
          "kind": "human", "auth": "session", "totpEnabled": true,
          "totpEnrollmentRequired": false,
          "stores": [{ "storeId": "store-1", "slug": "shop", "name": "Shop",
                       "currency": "USD", "role": "read_only" }] }
        """.data(using: .utf8)!
        let response = try decoder().decode(MeResponse.self, from: json)
        XCTAssertEqual(response.admin.email, "operator@example.com")
        XCTAssertEqual(response.stores.first?.role, "read_only")
    }

    func testWriteRoleAllowlistFailsClosed() {
        for role in ["owner", "manager", "staff"] {
            XCTAssertTrue(StoreAccess.canWrite(role: role), role)
        }
        let denied: [String?] = [nil, "read_only", "viewer", "OWNER", "unknown", ""]
        for role in denied {
            XCTAssertFalse(StoreAccess.canWrite(role: role), role ?? "nil")
        }
    }

    func testSalePricePatchDistinguishesUnchangedSetAndClear() throws {
        func object(_ patch: VariantPatch) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
        }
        XCTAssertTrue(try object(VariantPatch()).isEmpty)
        XCTAssertFalse(VariantPatch().hasChanges)
        var patch = VariantPatch()
        patch.salePrice = .set(1250)
        XCTAssertTrue(patch.hasChanges)
        XCTAssertEqual(try object(patch)["salePrice"] as? Int, 1250)
        patch.salePrice = .clear
        XCTAssertTrue(patch.hasChanges)
        let cleared = try object(patch)
        XCTAssertEqual(cleared.count, 1)
        XCTAssertTrue(cleared["salePrice"] is NSNull)
        patch.price = 2000
        patch.enabled = false
        let combined = try object(patch)
        XCTAssertTrue(combined["salePrice"] is NSNull)
        XCTAssertEqual(combined["price"] as? Int, 2000)
        XCTAssertEqual(combined["enabled"] as? Bool, false)
    }

    func testPendingPaymentFilterKeepsWireValueSeparateFromLabel() throws {
        let filter = try XCTUnwrap(OrderStateFilter.allCases.first { $0.rawValue == "PendingPayment" })
        XCTAssertEqual(filter.title, "Payment pending")
        XCTAssertFalse(OrderStateFilter.allCases.contains { $0.rawValue == "PaymentPending" })
    }

    @MainActor
    func testFailedAppendRetriesSamePageWithoutLosingRows() async {
        let list = PaginatedList<Int>()
        var requested: [Int] = []
        let fetch: (Int) async throws -> Page<Int> = { page in
            requested.append(page)
            if requested.count == 2 { throw URLError(.notConnectedToInternet) }
            return Page(items: [page], total: 3, page: page, pageSize: 1)
        }
        await list.load(replacing: true, fetch: fetch)
        await list.load(replacing: false, fetch: fetch)
        XCTAssertEqual(list.items, [1])
        XCTAssertEqual(list.page, 1)
        XCTAssertNotNil(list.errorMessage)
        XCTAssertFalse(list.loading)

        await list.retry(fetch: fetch)
        XCTAssertEqual(requested, [1, 2, 2])
        XCTAssertEqual(list.items, [1, 2])
        XCTAssertNil(list.errorMessage)
        await list.load(replacing: false, fetch: fetch)
        XCTAssertEqual(list.items, [1, 2, 3])
        XCTAssertFalse(list.hasMore)
    }

    @MainActor
    func testFailedInitialLoadRetriesFirstPage() async {
        let list = PaginatedList<Int>()
        await list.load(replacing: true) { _ in throw URLError(.notConnectedToInternet) }
        XCTAssertTrue(list.items.isEmpty)
        XCTAssertEqual(list.page, 0)
        XCTAssertNotNil(list.errorMessage)
        var requested: [Int] = []
        await list.retry { page in
            requested.append(page)
            return Page(items: [10], total: 1, page: page, pageSize: 1)
        }
        XCTAssertEqual(requested, [1])
        XCTAssertEqual(list.items, [10])
        XCTAssertNil(list.errorMessage)
    }

    @MainActor
    func testFailedRefreshRetriesReplacementWithoutAppendingDuplicates() async {
        let list = PaginatedList<Int>()
        await list.load(replacing: true) { Page(items: [1], total: 2, page: $0, pageSize: 1) }
        await list.load(replacing: false) { Page(items: [2], total: 2, page: $0, pageSize: 1) }
        await list.load(replacing: true) { _ in throw URLError(.notConnectedToInternet) }
        XCTAssertEqual(list.items, [1, 2])
        XCTAssertEqual(list.page, 2)
        var requested: [Int] = []
        await list.retry { page in
            requested.append(page)
            return Page(items: [10], total: 1, page: page, pageSize: 1)
        }
        XCTAssertEqual(requested, [1])
        XCTAssertEqual(list.items, [10])
        XCTAssertEqual(list.page, 1)
    }

    @MainActor
    func testQueryChangeDiscardsInFlightAppendAndPreventsDuplicateRequests() async throws {
        let list = PaginatedList<Int>()
        await list.load(replacing: true) { Page(items: [1], total: 2, page: $0, pageSize: 1) }
        let started = expectation(description: "append started")
        var pending: CheckedContinuation<Page<Int>, Error>?
        let append = Task { @MainActor in
            await list.load(replacing: false) { _ in
                try await withCheckedThrowingContinuation { continuation in
                    pending = continuation
                    started.fulfill()
                }
            }
        }
        await fulfillment(of: [started], timeout: 1)
        let continuation = try XCTUnwrap(pending)
        await list.load(replacing: false) { _ in
            XCTFail("An append already in flight must not request another copy")
            return Page(items: [2], total: 2, page: 2, pageSize: 1)
        }
        list.invalidate()
        await list.load(replacing: true) { Page(items: [20], total: 1, page: $0, pageSize: 1) }
        continuation.resume(returning: Page(items: [2], total: 2, page: 2, pageSize: 1))
        await append.value
        XCTAssertEqual(list.items, [20])
        XCTAssertEqual(list.page, 1)
        XCTAssertFalse(list.loading)
    }
}
