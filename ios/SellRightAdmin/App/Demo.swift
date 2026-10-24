import Foundation

#if DEBUG
/// Debug-only sample store for rendered checks: launch with `-SellRightDemo` and the
/// app signs in to fixture data served by a URLProtocol (never compiled into Release).
enum Demo {
    static var isOn: Bool { ProcessInfo.processInfo.arguments.contains("-SellRightDemo") }
    static let serverURL = "https://demo.sellright.invalid"
    static let token = "demo-session"

    static let urlSession: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [DemoURLProtocol.self]
        return URLSession(configuration: c)
    }()

    static func body(for path: String) -> String? {
        switch path {
        case "/v1/admin/me":
            return #"{"email":"owner@example.com","stores":[{"storeId":"st_1","slug":"example","name":"Example Store","currency":"USD","role":"owner"}]}"#
        case "/v1/admin/dashboard":
            return #"{"store":{"slug":"example","name":"Example Store","currency":"USD"},"revenue":1846500,"orders":231,"aov":7994,"pendingFulfillment":4,"customers":198,"lowStock":2,"recentOrders":\#(recentOrdersJSON)}"#
        case "/v1/admin/orders":
            return #"{"items":\#(recentOrdersJSON),"total":8,"page":1,"pageSize":25}"#
        default:
            return nil
        }
    }

    private static let orders: [(String, String, Int, String)] = [
        ("EX-1042", "Paid", 7500, "maya@example.com"), ("EX-1041", "Paid", 15500, "jon@example.com"),
        ("EX-1040", "Shipped", 8000, "ana@example.com"), ("EX-1039", "Delivered", 7500, "sam@example.com"),
        ("EX-1038", "Paid", 16000, "lee@example.com"), ("EX-1037", "Refunded", 7500, "kit@example.com"),
        ("EX-1036", "Delivered", 8000, "ola@example.com"), ("EX-1035", "Cancelled", 7500, "ravi@example.com"),
    ]

    private static var recentOrdersJSON: String {
        "[" + orders.enumerated().map { i, o in
            #"{"code":"\#(o.0)","state":"\#(o.1)","grandTotal":\#(o.2),"currency":"USD","placedAt":"2026-10-2\#(3 - min(i / 3, 3))T1\#(i % 10):05:00.000Z","email":"\#(o.3)"}"#
        }.joined(separator: ",") + "]"
    }
}

final class DemoURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path() ?? ""
        let body = Demo.body(for: path)
        let status = body == nil ? 404 : 200
        let data = Data((body ?? #"{"error":"not in the demo store"}"#).utf8)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
#endif
