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

Or open the generated `SellRightAdmin.xcodeproj` (gitignored) in Xcode and run. The
`RightKitSwift` package (`github.com/bogusyogi/rightkit`, pinned exactly at
`0.8.1`) resolves over your git credentials — `-scmProvider system`
makes xcodebuild use system git instead of Xcode's own SCM store.

Deterministic presentation checks without a server: launch a Debug build with
`-SellRightDemo` (synthetic Example Store, no network, compiled out of Release).
These checks cover the sample UI only; they do not validate live store data or
server-backed workflows.

## Live visual journey

The opt-in UI journey uses the public demo service at `demo.sellright.cc` and
keeps XCTest screenshots as result attachments. It is skipped unless
`SELLRIGHT_LIVE_VISUAL=1` reaches the test runner. Forward it with
`TEST_RUNNER_SELLRIGHT_LIVE_VISUAL=1` when invoking xcodebuild. Run it on an
installed iPad Simulator; replace the destination placeholder with that
simulator's UDID:

```sh
cd ios
TEST_RUNNER_SELLRIGHT_LIVE_VISUAL=1 xcodebuild -project SellRightAdmin.xcodeproj \
  -scheme SellRightAdmin \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  -only-testing:SellRightAdminUITests/LiveDemoVisualJourney test
```

The journey covers address validation, sign-in, and live dashboard, order,
product, customer, and account screens in light and dark appearance. An iPad
landscape run also checks accessibility-sized text. It depends on the public
demo being reachable and is separate from the synthetic `-SellRightDemo`
presentation checks.

## TestFlight

RightKit's shared iOS recipe (`targets.ios` in the root `right-release.config.mjs`).
Archive and export run from the logged-in desktop session on the Mac (an SSH
session is refused); the upload uses the shared App Store Connect key in the Mac
Keychain and adds the build to the `Internal` group.

```sh
right-release build --platform ios
right-release upload --platform ios --release <sealed-id> --apply
```

## Server contract

- `POST /v1/admin/login` `{email, password, returnToken: true}` → `{token, admin, stores}`,
  or for an account with a second factor `{twoFactorRequired, challengeToken, methods}`;
  then `POST /v1/admin/login/2fa` `{challengeToken, code, returnToken: true}` → `{token, admin, stores}`.
  The token goes in `Authorization: Bearer` and is stored in the Keychain (RightKit `SecretsStore`).
- Store selection is the `x-store-slug` header (same as the web admin).
- All money values are integer cents; `Money.format` divides only at display.
- Point the login screen at any SellRight store (`yourstore.com`; https is
  added). Plain http works only for a local dev server (`http://localhost:3300`),
  which the Info.plist ATS exception allows.

The app connects to any merchant's SellRight server. It has no built-in store
domains or associated-domain entitlements. Choose saved credentials through your
password manager; no AASA setup is required for this flow.

## Saved accounts

Enter a store address, continue to email/password, then complete 2FA if enabled.
Settings → Accounts → Add account saves another server/account without signing
out of the current one. Use Accounts in Settings or Saved accounts on sign-in
to switch. Each profile retains its own selected store & Keychain token; passwords
are never saved by the app. Signing out removes only that profile's session.

Upgrading from the original single-account app imports account details & asks
for one fresh sign-in. Its old session is retired to clear push registrations
that predate profile tracking; cleanup retries after reconnecting if needed.

Push registration follows the active account & store. Switching accounts clears
previous account screens, notifications & Live Activities. Existing unscoped
order notifications open the app without jumping into an order, because their
payload does not identify its originating server/account.

## Push + Live Activity

Order lands → banner + sound → the Dynamic Island tracks it Paid → Shipped →
Delivered → tap to open the order. The server side is a transactional outbox
(`packages/api/src/push/`) enqueued in the same txn as the paid transition, so a
rolled-back order never dings anyone.

**Requires an APNs key that only Adrian can mint** — see
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
Don't hand-tune colors here — fix the web generator and re-transcribe.

## Status / next steps

Wired: auth + session restore (Keychain), standard username/password fields
for manual password-manager selection, dashboard KPIs, orders (search,
state filter, pagination, detail, fulfill with tracking, refunds, restock,
cancel), products (list, detail, variant price/sale-price/enabled editing,
on-hand stock for physical variants), customers (list, detail with lifetime
stats/addresses/orders), saved account profiles & multi-store switching.

Sign-in uses the approved green vertical mark and an accessible system rounded
wordmark. Four operational themes (Vermillion, Graphite, Porcelain, Carbon)
remain selectable in Settings.

Not yet built: draft orders, returns approve/reject, marketing/promotions,
reports, blog CMS, licenses/subscriptions admin, and asset upload.
