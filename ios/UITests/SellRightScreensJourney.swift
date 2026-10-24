import XCTest

/// Rendered evidence for the SellRight Admin app. Launches the Debug app against the demo store
/// (`-SellRightDemo`, SellRightAdmin/App/Demo.swift: fixture data over a URLProtocol, no network,
/// no notification prompt; compiled only into Debug) and attaches a screenshot at each step.
/// Kept on success; read them from the .xcresult.
@MainActor
final class SellRightScreensJourney: XCTestCase {
    private var app: XCUIApplication!

    /// smoke.launch: the app launches and signs in to the demo store (tab bar present).
    func testLaunchSmoke() throws {
        launch()
        wait(tab("Home"))
        shot("01-launch")
    }

    /// journey: Home (recent orders) → Orders → Products → Customers → Settings.
    func testAdminJourney() throws {
        launch()

        wait(tab("Home"))
        wait(text("RH-1042"))
        shot("02-home")

        tab("Orders").tap()
        wait(app.navigationBars["Orders"])
        wait(text("RH-1041"))
        shot("03-orders")

        tab("Products").tap()
        shot("04-products")

        tab("Customers").tap()
        shot("05-customers")

        tab("Settings").tap()
        shot("06-settings")
    }

    // MARK: Helpers

    private func launch() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-SellRightDemo"]
        app.launch()
    }

    private func tab(_ name: String) -> XCUIElement {
        app.tabBars.buttons[name].firstMatch
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

    /// Lets transitions settle, then attaches a full-screen screenshot.
    private func shot(_ name: String) {
        Thread.sleep(forTimeInterval: 0.6)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
