import XCTest

@MainActor
final class SignInUITests: XCTestCase {
    func testStoreAddressAppearsBeforeCredentialsAndChangingAddressClearsCredentials() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-serverURL", "",
            "-storeProfiles.v1", "",
            "-activeStoreProfile.v1", "",
            "-pushRegistrations.v1", "",
        ]
        app.launch()

        let address = app.textFields["login.serverAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        XCTAssertEqual(address.value as? String, "yourstore.com")
        XCTAssertFalse(app.textFields["login.email"].exists)
        XCTAssertFalse(app.secureTextFields["login.password"].exists)
        attachScreenshot("Sign-in address", app)

        address.tap()
        address.typeText("merchant.example.com")
        app.buttons["login.continue"].tap()

        let email = app.textFields["login.email"]
        let password = app.secureTextFields["login.password"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        XCTAssertTrue(password.exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "merchant.example.com")).firstMatch.exists)
        attachScreenshot("Sign-in credentials", app)

        app.buttons["Change store address"].tap()
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        XCTAssertFalse(email.exists)
        XCTAssertFalse(password.exists)
        attachScreenshot("Sign-in address reset", app)
    }

    func testCancelAddAccountPreservesDemoAccount() {
        let app = XCUIApplication()
        app.launchArguments = ["-SellRightDemo", "-pushRegistrations.v1", ""]
        app.launch()

        let settingsTab = app.buttons["Settings"]
        XCTAssertTrue(settingsTab.waitForExistence(timeout: 10))
        settingsTab.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Signed in as, owner@example.com"].waitForExistence(timeout: 5))

        app.buttons["settings.addAccount"].tap()
        let address = app.textFields["login.serverAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["login.email"].exists)
        XCTAssertFalse(app.secureTextFields["login.password"].exists)
        attachScreenshot("Add account address", app)

        app.buttons["login.cancel"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Signed in as, owner@example.com"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Server, demo.sellright.invalid"].exists)
        attachScreenshot("Demo account after cancel", app)
    }

    private func attachScreenshot(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
