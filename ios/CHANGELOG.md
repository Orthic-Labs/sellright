# Changelog — SellRight Admin iOS

Notable changes to the native iOS admin app only. The SellRight API, storefront,
and browser admin use the repository-root changelog.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every iOS feature, fix, or security change must update this file in the same
push.

## [Unreleased]

### Added

- TestFlight release through RightKit's shared iOS recipe (`targets.ios` in `right-release.config.mjs`), version 0.2.0.
- Debug-only demo store (`-SellRightDemo` launch argument) for rendered checks; compiled out of Release.
- RightKit QA lane: a `SellRightAdminUITests` XCUITest bundle (`ios/project.yml`) with the screens journey (`ios/UITests/SellRightScreensJourney.swift`), as Pulse's iOS app has.
- The release runs through `@rightkit/release` 0.6.4 (root devDependency, `pnpm release:doctor`). `right-release.config.mjs` declares the web and server workflows as unrelated to the iOS release (`hostedWorkflows: declared-unrelated`), declares no Rust (`releaseSwitches.rust: false`), and `switches.json` is the app's switch inventory (empty: the iOS sources read no environment switch).

### Changed

- Sign-in follows the two-step admin login (#333): email + password first, then the authenticator or recovery
  code only for an account with a second factor. The old single-form login could not sign in a 2FA account.
- The store address accepts a bare domain (`yourstore.com`) and always uses https; plain http only for local dev
  servers. No `localhost` default.
- Aligned with the other Orthic apps: Swift 6 language mode, iOS 18 floor, `MARKETING_VERSION`, RightKitSwift
  pinned exactly at 0.8.1 (`bogusyogi/rightkit`); the session token now lives in RightKit's shared `SecretsStore`.
- iOS 26/27 design: TabView `Tab` API with the sidebar-adaptable iPad layout, tab bar that minimizes on scroll,
  Liquid Glass sign-in button.
- iPad supports every orientation (App Store validation requires it for multitasking).
- `NSSupportsLiveActivities` is declared on the app, which the order Live Activity needs.

- The `webcredentials` associated domain for the browser admin is now `admin.sellright.cc` (was `admin.spoares.com`).
- The app icon catalog now ships the complete RGB iOS icon set generated from
  the selected SellRight mark.

## 2026-07-17

### Added

- The first native SellRight Admin app: mobile order operations backed by the
  production admin API (`2a7f53c`).
- Push notifications and Dynamic Island Live Activities for order events, plus
  the four-theme system (`bfac16a`).

### Fixed

- Per-line refund construction now receives the order-line identifiers exposed
  by the API (`7be6ad6`).
