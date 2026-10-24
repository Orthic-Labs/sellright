import XCTest

/// Rendered checks against Debug-only demo fixtures: no network or notification prompt.
/// Screenshots remain in the result bundle even when tests pass.
@MainActor
final class SellRightScreensJourney: XCTestCase {
    private var app: XCUIApplication!

    func testLaunchSmoke() {
        launch()
        wait(tab("Home"))
        wait(app.navigationBars["Example Store"])
        wait(text("EX-1042"))
        shot("01-launch")
    }

    /// Dashboard & orders use generic fixtures; catalog tabs expose their unavailable states.
    func testAdminJourney() {
        launch()

        wait(tab("Home"))
        wait(app.navigationBars["Example Store"])
        wait(text("EX-1042"))
        shot("02-home")

        tab("Orders").tap()
        wait(app.navigationBars["Orders"])
        wait(text("EX-1041"))
        shot("03-orders")

        tab("Products").tap()
        wait(app.navigationBars["Products"])
        wait(text("Couldn't load products"))
        shot("04-products-unavailable")

        tab("Customers").tap()
        wait(app.navigationBars["Customers"])
        wait(text("Couldn't load customers"))
        shot("05-customers-unavailable")

        tab("Settings").tap()
        wait(app.navigationBars["Settings"])
        wait(text("Signed in as, owner@example.com"))
        wait(text("Server, demo.sellright.invalid"))
        shot("06-settings")
    }

    private func launch() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = [
            "-SellRightDemo",
            "-serverURL", "",
            "-storeProfiles.v1", "",
            "-activeStoreProfile.v1", "",
            "-pushRegistrations.v1", "",
        ]
        app.launch()
    }

    private func tab(_ name: String) -> XCUIElement {
        app.buttons[name].firstMatch
    }

    private func text(_ label: String) -> XCUIElement {
        app.staticTexts[label].firstMatch
    }

    @discardableResult
    private func wait(_ element: XCUIElement, timeout: TimeInterval = 10,
                      file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Not found: \(element)", file: file, line: line)
        return element
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
