import XCTest

/// Explicit live visual audit against the public demo store. These tests are skipped
/// unless the test runner opts in with SELLRIGHT_LIVE_VISUAL=1.
@MainActor
final class LiveDemoVisualJourney: XCTestCase {
    private var app: XCUIApplication!
    private static let defaultLiveBaseAddress = "https://demo.sellright.cc"

    private static var configuredLiveBaseURL: URL? {
        let override = ProcessInfo.processInfo.environment["SELLRIGHT_LIVE_BASE_URL"]
        let rawAddress = override ?? defaultLiveBaseAddress
        guard let components = URLComponents(string: rawAddress),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let url = components.url else { return nil }
        if override == nil {
            guard scheme == "https", host == "demo.sellright.cc",
                  components.port == nil || components.port == 443 else { return nil }
            return url
        }
        if scheme == "http", (host == "localhost" || host == "127.0.0.1") {
            return url
        }
        if scheme == "https", host == "demo.sellright.cc",
           components.port == nil || components.port == 443 {
            return url
        }
        return nil
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
        guard ProcessInfo.processInfo.environment["SELLRIGHT_LIVE_VISUAL"] == "1" else {
            throw XCTSkip("Set SELLRIGHT_LIVE_VISUAL=1 to run against the live demo.")
        }
        guard Self.configuredLiveBaseURL != nil else {
            throw NSError(domain: "LiveDemoVisualJourney", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "TEST_RUNNER_SELLRIGHT_LIVE_BASE_URL must be the default HTTPS demo URL or HTTP localhost/127.0.0.1 URL."
            ])
        }
    }

    func testLiveJourneyLight() throws {
        try runJourney(theme: "light")
    }

    func testLiveJourneyDark() throws {
        try runJourney(theme: "dark")
    }

    /// Run on iPad Simulator to capture the wide layout with accessibility-sized text.
    func testLiveJourneyAccessibilityLandscape() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        try runJourney(theme: "light", accessibilityText: true)
    }

    func testLiveAddressValidation() {
        launch(theme: "light")
        let address = app.textFields["login.serverAddress"]
        wait(address)
        address.tap()
        address.typeText("not a valid address")
        shot("validation-address-keyboard")
        app.buttons["login.continue"].tap()
        wait(app.descendants(matching: .any)["login.error"])
        shot("validation-invalid-address")
    }

    private func runJourney(theme: String, accessibilityText: Bool = false) throws {
        launch(theme: theme, accessibilityText: accessibilityText)

        let address = app.textFields["login.serverAddress"]
        wait(address)
        shot("\(theme)-01-first-run-address")
        address.tap()
        shot("\(theme)-02-address-keyboard")
        address.typeText(Self.configuredLiveBaseURL!.absoluteString)
        app.buttons["login.continue"].tap()

        let email = app.textFields["login.email"]
        let password = app.secureTextFields["login.password"]
        wait(email)
        wait(password)
        shot("\(theme)-03-credentials")
        email.tap()
        email.typeText("admin")
        password.tap()
        password.typeText("admin")
        shot("\(theme)-04-credentials-keyboard")
        app.buttons["login.signIn"].tap()

        handleNotificationPromptIfPresent()
        wait(app.staticTexts["Revenue"], timeout: 30)
        wait(app.staticTexts["Recent orders"], timeout: 30)
        XCTAssertFalse(app.staticTexts["Couldn't load dashboard"].exists)
        shot("\(theme)-05-dashboard-populated")

        selectTab("Orders")
        wait(app.navigationBars["Orders"])
        let paidOrder = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Paid")).firstMatch
        wait(paidOrder, timeout: 30)
        XCTAssertFalse(app.staticTexts["Couldn't load orders"].exists)
        shot("\(theme)-06-orders-populated")
        let search = app.searchFields["Order code or email"]
        wait(search).tap()
        let noResultQuery = "zzzz-live-visual-no-result"
        search.typeText(noResultQuery)
        wait(app.staticTexts["No Results"], timeout: 20)
        shot("\(theme)-07-orders-search-no-result")
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: noResultQuery.count))
        let closeSearch = app.buttons["Close"]
        let cancelSearch = app.buttons["Cancel"]
        if closeSearch.waitForExistence(timeout: 2) && closeSearch.isHittable {
            closeSearch.tap()
        } else if cancelSearch.waitForExistence(timeout: 2) && cancelSearch.isHittable {
            cancelSearch.tap()
        } else {
            XCTFail("Search dismissal control is not visible or hittable.")
        }
        let keyboard = app.keyboards.firstMatch
        let keyboardGone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard)
        XCTAssertEqual(XCTWaiter.wait(for: [keyboardGone], timeout: 5), .completed, "Search keyboard remained visible after dismissal.")
        shot("\(theme)-orders-search-dismissed")
        wait(paidOrder, timeout: 30)
        paidOrder.tap()
        wait(app.navigationBars.element(boundBy: 0), timeout: 15)
        XCTAssertFalse(app.staticTexts["Couldn't load order"].exists)
        wait(app.staticTexts["Items"], timeout: 20)
        shot("\(theme)-07-order-detail")

        let actions = app.buttons["More"]
        wait(actions).tap()
        let fulfill = app.buttons["Fulfill…"]
        wait(fulfill).tap()
        Thread.sleep(forTimeInterval: 1.0)
        shot("\(theme)-fulfill-after-tap")
        dumpHierarchy("\(theme)-fulfill-after-tap")
        wait(app.navigationBars.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ OR label BEGINSWITH %@", "Fulfill ", "Fulfill "
        )).firstMatch)
        XCTAssertTrue(app.buttons["Cancel"].exists)
        shot("\(theme)-08-fulfillment-sheet")
        app.buttons["Cancel"].tap()
        wait(app.staticTexts["Items"], timeout: 15)
        shot("\(theme)-09-fulfillment-cancelled")
        actions.tap()
        let refund = app.buttons["Refund…"]
        wait(refund).tap()
        Thread.sleep(forTimeInterval: 1.0)
        shot("\(theme)-refund-after-tap")
        dumpHierarchy("\(theme)-refund-after-tap")
        wait(app.navigationBars.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ OR label BEGINSWITH %@", "Refund ", "Refund "
        )).firstMatch)
        XCTAssertTrue(app.buttons["Cancel"].exists)
        shot("\(theme)-08-refund-sheet")
        app.buttons["Cancel"].tap()
        wait(app.navigationBars.element(boundBy: 0))
        shot("\(theme)-09-refund-cancelled")
        app.navigationBars.buttons.firstMatch.tap()

        selectTab("Products")
        wait(app.navigationBars["Products"])
        let productRow = app.staticTexts["Studio Notebook"]
        wait(productRow, timeout: 30)
        XCTAssertFalse(app.staticTexts["Couldn't load products"].exists)
        let productTitle = productRow.label
        shot("\(theme)-11-products-populated")
        productRow.tap()
        wait(app.navigationBars[productTitle], timeout: 20)
        wait(app.staticTexts["Variants"], timeout: 20)
        shot("\(theme)-11-product-detail")
        let variant = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "available")).firstMatch
        wait(variant, timeout: 20).tap()
        wait(app.buttons["Save"], timeout: 10)
        XCTAssertTrue(app.buttons["Cancel"].exists)
        shot("\(theme)-12-variant-edit-sheet")
        app.buttons["Cancel"].tap()
        wait(app.navigationBars[productTitle], timeout: 10)
        app.navigationBars.buttons.firstMatch.tap()

        selectTab("Customers")
        wait(app.navigationBars["Customers"])
        let customerRow = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "@")).firstMatch
        wait(customerRow, timeout: 30)
        XCTAssertFalse(app.staticTexts["Couldn't load customers"].exists)
        shot("\(theme)-12-customers-populated")
        customerRow.tap()
        wait(app.navigationBars.element(boundBy: 0), timeout: 20)
        wait(app.staticTexts["Lifetime"], timeout: 20)
        shot("\(theme)-13-customer-detail")
        let customerOrder = app.buttons.matching(NSPredicate(
            format: "label CONTAINS %@ OR label CONTAINS %@ OR label CONTAINS %@",
            "1001", "1002", "1003"
        )).firstMatch
        wait(customerOrder, timeout: 20).tap()
        wait(app.staticTexts["Items"], timeout: 20)
        XCTAssertFalse(app.staticTexts["Couldn't load order"].exists)
        shot("\(theme)-14-customer-order-detail")

        selectTab("Settings")
        wait(app.navigationBars["Settings"])
        let expectedHost = Self.configuredLiveBaseURL!.host!
        let host = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", expectedHost)).firstMatch
        wait(host, timeout: 10)
        let signedIn = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Signed in as")).firstMatch
        wait(signedIn)
        let originalAccount = signedIn.label
        let originalHost = host.label
        shot("\(theme)-14-settings")
        app.buttons["settings.addAccount"].tap()
        wait(app.textFields["login.serverAddress"])
        shot("\(theme)-15-add-account-address")
        app.buttons["login.cancel"].tap()
        wait(app.navigationBars["Settings"])
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", expectedHost)).firstMatch.label, originalHost)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Signed in as")).firstMatch.label, originalAccount)
        shot("\(theme)-16-account-after-add-cancel")
    }

    private func launch(theme: String, accessibilityText: Bool = false) {
        app = XCUIApplication()
        app.launchArguments = [
            "-serverURL", "",
            "-storeProfiles.v1", "",
            "-activeStoreProfile.v1", "",
            "-pushRegistrations.v1", "",
            "-themeName", "vermillion",
            "-themeMode", theme,
        ]
        if accessibilityText {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        }
        app.launch()
    }

    private func selectTab(_ name: String) {
        let tabButton = app.tabBars.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
        wait(tabButton, timeout: 10)
        dumpHierarchy("before-tab-\(name)")

        let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: tabButton)
        XCTAssertEqual(
            XCTWaiter.wait(for: [hittable], timeout: 5),
            .completed,
            "Tab bar button is not hittable; inspect UI obstruction before selecting \(name).\n\(app.debugDescription)"
        )
        tabButton.tap()

        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: tabButton)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed, "Tab did not become selected: \(name)")
        dumpHierarchy("after-tab-\(name)")
        shot("after-tab-\(name)")
    }

    @discardableResult
    private func wait(_ element: XCUIElement, timeout: TimeInterval = 10,
                      file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Not found: \(element)", file: file, line: line)
        return element
    }

    private func handleNotificationPromptIfPresent() {
        let springBoard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alerts = [app.alerts.firstMatch, springBoard.alerts.firstMatch]
        for alert in alerts where alert.waitForExistence(timeout: 1) {
            let curlyDeny = alert.buttons["Don’t Allow"]
            let straightDeny = alert.buttons["Don't Allow"]
            if curlyDeny.exists {
                curlyDeny.tap()
                return
            }
            if straightDeny.exists {
                straightDeny.tap()
                return
            }
        }
    }

    private func dumpHierarchy(_ name: String) {
        let hierarchy = app.debugDescription
        let attachment = XCTAttachment(string: hierarchy)
        attachment.name = "\(name)-hierarchy"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("LIVE_UI_HIERARCHY[\(name)]\n\(hierarchy)")
    }

    private func shot(_ name: String) {
        Thread.sleep(forTimeInterval: 0.6)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
