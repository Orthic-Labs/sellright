import XCTest
@testable import SellRightAdmin

@MainActor
final class AuthTests: XCTestCase {
    func testServerAddressAcceptsBareHostAndForcesHTTPS() {
        XCTAssertEqual(AppSession.normalizedServerURL("rottenhand.com")?.absoluteString, "https://rottenhand.com")
        XCTAssertEqual(AppSession.normalizedServerURL(" https://admin.orthiclabs.com/ ")?.absoluteString, "https://admin.orthiclabs.com")
        XCTAssertNil(AppSession.normalizedServerURL(""))
        // Plain http only for a local dev server; never for a public host.
        XCTAssertNil(AppSession.normalizedServerURL("http://rottenhand.com"))
        XCTAssertNotNil(AppSession.normalizedServerURL("http://localhost:3300"))
        XCTAssertNotNil(AppSession.normalizedServerURL("http://192.168.1.16:3300"))
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
