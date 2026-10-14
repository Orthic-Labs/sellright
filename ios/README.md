# SellRight Admin — iOS

Run your SellRight store from your phone: dashboard KPIs, orders (search,
filter, detail, fulfill with tracking), products, multi-store switching.
Companion to the web admin, speaking the same
`/v1/admin/*` REST API with a bearer token (CSRF-exempt API-client path).

## Layout

```
ios/
  project.yml                XcodeGen spec (app, widget extension, unit tests, RightKitSwift pinned)
  SellRightAdmin/
    App/                     entry point, session/auth state, theme tokens
    Core/                    API client, Codable models, Keychain, push + Live Activity control, diagnostics
    Features/
      Auth/                  server URL + email/password/TOTP login
      Dashboard/             KPI grid + recent orders
      Orders/                list (search/filter/paginate), detail, fulfill, refund, cancel
      Products/              list with stock + min price, detail with variant editing
      Customers/             list, detail
      Settings/              theme, store switcher, account, sign out
  SellRightWidgets/          Live Activity widget extension
  Shared/                    money formatting + Live Activity attributes (compiled into app and widgets)
  Tests/                     model decoding, money formatting, theme contrast checks
```

## Build

```sh
brew install xcodegen   # once
cd ios
xcodegen                # generates SellRightAdmin.xcodeproj from project.yml
xcodebuild -project SellRightAdmin.xcodeproj -scheme SellRightAdmin \
  -destination 'generic/platform=iOS Simulator' -scmProvider system build
```

Or open the generated `SellRightAdmin.xcodeproj` in Xcode and run. The
`RightKitSwift` package (`github.com/bogusyogi/rightkit-swift`, pinned
`from: 0.1.0`) resolves over your git credentials — `-scmProvider system`
makes xcodebuild use system git instead of Xcode's own SCM store.

The deployment target is iOS 17.2, the app targets iPhone and iPad (portrait
only), and the bundle id is `app.sellright.ios.admin`. `project.yml` sets
`DEVELOPMENT_TEAM` to the maintainer's team ID; change it to build with your own
signing.

## Server contract

- `POST /v1/admin/login` `{email, password, totp?}` → `{token, admin, stores}`;
  the token goes in `Authorization: Bearer` and is stored in the Keychain.
- Store selection is the `x-store-slug` header (same as the web admin).
- All money values are integer cents; `Money.format` divides only at display.
- Point the login screen at any SellRight API (`http://localhost:3300` in dev —
  local networking is allowed by the Info.plist ATS exception; production
  servers must be https).

## Push + Live Activity

Order lands → banner + sound → the Dynamic Island tracks it Paid → Shipped →
Delivered → tap to open the order. The server side is a transactional outbox
(`packages/api/src/push/`) enqueued in the same txn as the paid transition, so a
rolled-back order never dings anyone.

The server starts the Live Activity only on the synchronous checkout paid path
(`packages/api/src/payments/settlement/handlers.ts`); orders that become paid
through gateway settle, webhook reconcile, `/pay` or a subscription first cycle
send the alert push only. Shipped and Delivered updates to the activity are made
by the app on the phone, so an order fulfilled from the web admin does not move
it (see section 6 of [docs/IOS-PUSH-SETUP.md](../docs/IOS-PUSH-SETUP.md)).

**Requires an APNs key from the Apple Developer account that owns the app**; see
[docs/IOS-PUSH-SETUP.md](../docs/IOS-PUSH-SETUP.md). Without it everything runs;
it just never dings (the outbox fills and drains once the key lands).

Two token families register separately: `apns` (alert) and `live_activity`
(push-to-start, iOS 17.2+). A Debug build's token is **sandbox**; a TestFlight
build's is **production** — mixing them up is the classic silent failure, so the
app reports its own environment at registration.

## Themes

Four themes (Vermillion default, Graphite, Porcelain, Carbon) × light/dark/system,
switchable in Settings and persisted. Values are transcribed verbatim from
`packages/admin/src/theme-tokens.css` so web and mobile can't drift; `ThemeTests`
re-verifies WCAG AA contrast on all 8 palettes independently of the web checker.
Don't hand-tune colors here; change the web tokens and re-transcribe.

## Status / next steps

Wired: auth + session restore (Keychain), Password AutoFill (webcredentials
entitlement; the server must publish `/.well-known/apple-app-site-association`
and the API serves it from the `AASA_APP_IDS` env; `project.yml` lists
`webcredentials:api.spoares.com` and `webcredentials:admin.spoares.com`, both with
`?mode=developer`, so change them to your own API host), dashboard KPIs, orders (search,
state filter, pagination, detail, fulfill with tracking, refunds — full,
per-line, or amount override — with restock, cancel), products (list, detail,
variant price/sale-price/enabled
editing, on-hand stock for physical variants), customers (list, detail with
lifetime stats/addresses/orders), multi-store switching.

Not yet built: draft orders, returns approve/reject, marketing/promotions,
reports, blog CMS, licenses/subscriptions admin, asset upload, and a locked
SellRight brand identity (the theme system is ported from the web admin;
`Theme.swift` notes that no Right Suite identity is locked yet).

Release status: this repo has no iOS CI job, no fastlane or export-options file,
and `project.yml` sets `aps-environment: development` and version `0.1.0`. No
TestFlight or App Store release is configured here; the release steps are in
section 5 of [docs/IOS-PUSH-SETUP.md](../docs/IOS-PUSH-SETUP.md).
