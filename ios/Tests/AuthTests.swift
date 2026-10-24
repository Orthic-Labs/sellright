import XCTest
@testable import SellRightAdmin

@MainActor
final class AuthTests: XCTestCase {
    func testServerAddressAcceptsBareHostAndForcesHTTPS() {
        XCTAssertEqual(AppSession.normalizedServerURL("example.com")?.absoluteString, "https://example.com")
        XCTAssertEqual(AppSession.normalizedServerURL(" https://admin.example.com/ ")?.absoluteString, "https://admin.example.com")
        XCTAssertNil(AppSession.normalizedServerURL(""))
        // Plain http only for a local dev server; never for a public host.
        XCTAssertNil(AppSession.normalizedServerURL("http://example.com"))
        XCTAssertNotNil(AppSession.normalizedServerURL("http://localhost:3300"))
        XCTAssertNotNil(AppSession.normalizedServerURL("http://192.168.1.16:3300"))
    }

    func testServerAddressRejectsCredentialAndLookalikeHostsAndNormalizesOrigin() {
        XCTAssertNil(AppSession.normalizedServerURL("https://user:password@merchant.example"))
        XCTAssertNil(AppSession.normalizedServerURL("https://merchant.example?server=other.example"))
        XCTAssertNil(AppSession.normalizedServerURL("https://merchant.example#account"))
        XCTAssertNil(AppSession.normalizedServerURL("http://10.attacker.example"))
        XCTAssertNil(AppSession.normalizedServerURL("http://10.0.0.1.attacker.example"))
        XCTAssertNil(AppSession.normalizedServerURL("http://10.evil.0.0.1"))
        XCTAssertNil(AppSession.normalizedServerURL("http://+10.0.0.1"))
        XCTAssertNil(AppSession.normalizedServerURL("https://merchant..example"))
        XCTAssertNil(AppSession.normalizedServerURL("http://10..0.0.1"))
        XCTAssertNil(AppSession.normalizedServerURL("http://192.168.attacker.example"))
        XCTAssertNil(AppSession.normalizedServerURL("http://172.32.1.2"))
        XCTAssertNotNil(AppSession.normalizedServerURL("http://172.16.1.2:3300"))
        XCTAssertNotNil(AppSession.normalizedServerURL("http://[::1]:3300"))
        XCTAssertEqual(AppSession.normalizedServerURL("https://MERCHANT.example:443/admin/orders/")?.absoluteString,
                       "https://merchant.example")
    }

    func testStepOneChallengeDecodes() throws {
        let json = #"{"twoFactorRequired":true,"challengeToken":"abcdefghijklmnopqrstuv","expiresInSeconds":300,"methods":["totp","passkey","recovery_code"]}"#
        let res = try JSONDecoder().decode(LoginResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.twoFactorRequired, true)
        XCTAssertEqual(res.challengeToken, "abcdefghijklmnopqrstuv")
        XCTAssertEqual(res.methods ?? [], ["totp", "passkey", "recovery_code"])
        XCTAssertNil(res.token)
    }

    func testRequestsAskForTheBearerToken() throws {
        let step1 = try JSONSerialization.jsonObject(with: JSONEncoder().encode(LoginRequest(email: "a@b.co", password: "pw"))) as? [String: Any]
        XCTAssertEqual(step1?["returnToken"] as? Bool, true)
        XCTAssertNil(step1?["totp"])
        let step2 = try JSONSerialization.jsonObject(with: JSONEncoder().encode(LoginSecondStepRequest(challengeToken: "t", code: "123456"))) as? [String: Any]
        XCTAssertEqual(step2?["returnToken"] as? Bool, true)
        XCTAssertEqual(step2?["code"] as? String, "123456")
    }
}
