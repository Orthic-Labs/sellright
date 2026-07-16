# SellRight Admin — iOS

Run your SellRight store from your phone: dashboard KPIs, orders (search,
filter, detail, fulfill with tracking), products, multi-store switching.
Shopify-mobile-style companion to the web admin, speaking the same
`/v1/admin/*` REST API with a bearer token (CSRF-exempt API-client path).

## Layout

```
ios/
  project.yml                XcodeGen spec (app + unit tests, RightKitSwift pinned)
  SellRightAdmin/
    App/                     entry point, session/auth state, theme tokens
    Core/                    API client, Codable models, Keychain, money, diagnostics
    Features/
      Auth/                  server URL + email/password/TOTP login
      Dashboard/             KPI grid + recent orders
      Orders/                list (search/filter/paginate), detail, fulfill sheet
      Products/              list with stock + min price
      Settings/              store switcher, account, sign out
  Tests/                     model decoding + money formatting checks
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

## Server contract

- `POST /v1/admin/login` `{email, password, totp?}` → `{token, admin, stores}`;
  the token goes in `Authorization: Bearer` and is stored in the Keychain.
- Store selection is the `x-store-slug` header (same as the web admin).
- All money values are integer cents; `Money.format` divides only at display.
- Point the login screen at any SellRight API (`http://localhost:3300` in dev —
  local networking is allowed by the Info.plist ATS exception; production
  servers must be https).

## Status / next steps

Wired: auth + session restore (Keychain), Password AutoFill (webcredentials
entitlement; the server must publish `/.well-known/apple-app-site-association`
— `AASA_APP_IDS` env on the API serves it), dashboard KPIs, orders (search,
state filter, pagination, detail, fulfill with tracking, refunds — full,
per-line, or amount override — with restock, cancel), products (list, detail,
variant price/sale-price/enabled
editing, on-hand stock for physical variants), customers (list, detail with
lifetime stats/addresses/orders), multi-store switching.

Not yet built: draft orders, returns approve/reject,
marketing/promotions, reports, blog CMS, licenses/subscriptions admin, asset
upload, push notifications for new orders, and the SellRight visual identity
(placeholder theme until the brand locks; wordmark will be Tanker per Right
Suite rules).
