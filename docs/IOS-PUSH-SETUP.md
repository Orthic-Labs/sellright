# iOS Push + Live Activity — setup runbook (2026-07-17)

Everything in the code is done and tested. What remains is **credential and
account work that only Adrian can perform** (Apple developer portal, App Store
Connect) plus one env block on the box. This runbook is the whole list.

Nothing here is a code change. Until step 1 is done, the app runs fine and simply
never dings: `deliverPushes()` no-ops when `APNS_*` is unset, the outbox still
fills, and queued alerts drain once the key lands.

---

## 1. Mint the APNs key (Apple developer portal) — BLOCKING

developer.apple.com → Certificates, Identifiers & Profiles → **Keys** → `+`

- Name: `SellRight Admin Push` (anything)
- Enable **Apple Push Notifications service (APNs)**
- Download the `.p8` **once** — Apple will not let you download it again.

Take note of three values:

| Value | Where |
|---|---|
| **Key ID** | shown on the key page, e.g. `ABC123DEFG` |
| **Team ID** | top-right of the portal — `6KLGD3LLKF` for this account |
| **`.p8` contents** | the downloaded file |

One token key works for **every app under the team** and never expires. Do not
create a per-app key, and do not use the legacy certificate-based auth.

**Storage:** the `.p8` is a signing key — it can push to any app on the team.
Treat it like the updater key: never in the repo, never in a chat, never in a
screenshot. It belongs in the box's `packages/api/.env` (gitignored) only.

## 2. Enable the Push Notifications capability on the App ID

Same portal → **Identifiers** → `app.sellright.ios.admin` → tick **Push
Notifications**. Xcode's automatic signing already added the entitlement to the
dev build (verified: the device build signs with `iOS Team Provisioning Profile:
app.sellright.ios.admin`), but the App ID itself must have the capability for
production/TestFlight builds to receive anything.

## 3. Set the env on the box

`~/sites/sellright/packages/api/.env` (and the RightApps equivalent if that
deployment should push too):

```sh
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=6KLGD3LLKF
APNS_BUNDLE_ID=app.sellright.ios.admin
APNS_KEY_P8="-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----"
JOBS_ENABLED=1
JOBS_PUSH_ENABLED=1
```

`APNS_KEY_P8` accepts either literal newlines or `\n`-escaped (the loader
normalizes both — `apns.ts`). Then `pm2 restart sellright-api --update-env`.

**`JOBS_PUSH_ENABLED` is separate from `JOBS_ENABLED` on purpose:** the outbox
fills regardless, so you can turn delivery on later without having lost the
alerts queued in the meantime.

## 4. The sandbox/production trap (read this before debugging "push is broken")

This is the single most common cause of silent failure, so the app reports its
own environment at registration and the server pushes to the matching host.

| Build | APNs token is | `aps-environment` | Host |
|---|---|---|---|
| Debug / dev-signed (what's on the phone now) | **sandbox** | `development` | `api.sandbox.push.apple.com` |
| TestFlight / App Store | **production** | `production` | `api.push.apple.com` |

Sending a sandbox token to the production host fails with `BadDeviceToken`, and
vice versa. `project.yml` currently sets `aps-environment: development` — a
release build must flip it to `production`, or TestFlight installs get nothing.

## 5. TestFlight (needed for real-world use)

Dev-signed builds expire, so day-to-day use on a phone means TestFlight:

1. App Store Connect → new app record → bundle id `app.sellright.ios.admin`
2. `xcodebuild -scheme SellRightAdmin -configuration Release archive` → upload
3. Privacy nutrition labels. Be accurate: the app collects an **APNs device
   token** (linked to the operator's account, used only to deliver order alerts)
   and stores the session token in the Keychain. It has no analytics SDK and no
   third-party trackers; RightKit diagnostics are on-device JSONL, privacy-
   redacted, and never transmitted.
4. Export compliance: `ITSAppUsesNonExemptEncryption` is already `false` —
   correct, since the app only uses HTTPS/Keychain (exempt).

## 6. Live Activity notes

- **iOS 17.2+** is the deployment floor, specifically for push-to-start (starting
  an activity from a server push rather than the foreground app). That's why the
  target is 17.2, not 17.0.
- The push-to-start token is a **separate token** from the alert token; the app
  registers both (`kind: 'apns'` vs `kind: 'live_activity'`).
- Live Activity pushes go to `<bundle>.push-type.liveactivity` with
  `apns-push-type: liveactivity` — a different topic from alerts.
- `attributes-type` in the payload must stay `OrderActivityAttributes`, matching
  `ios/Shared/OrderActivityAttributes.swift`. Renaming the Swift type or a
  `ContentState` field without updating `buildOrderLiveActivityPayload` breaks the
  activity **silently** (APNs still returns 200).
- **Known limitation:** an order fulfilled from the *web* admin does not move the
  phone's Live Activity — it ages out at the 8h dismissal date. Fulfilling from
  the app updates it immediately (local `Activity.update`). Closing that gap needs
  per-activity update tokens registered server-side; deliberately not built,
  since the operator working the order is the one holding the phone.

## 7. Verifying it works, end to end

Once step 1–3 are done:

```sh
# On the box: watch the push outbox drain.
psql "$DATABASE_URL_OWNER" -c "SELECT topic, status, attempts, last_error FROM push_outbox ORDER BY created_at DESC LIMIT 5;"
```

Place a real (or test-mode) order on the store. Expected: a `pending` row appears
per registered device, the scheduler flips it to `sent` within a minute, the phone
shows a banner + sound, and the Dynamic Island shows the order. Tapping the
banner opens that order.

If rows go `dead` with `unregistered`, the device token was pruned — that's the
410 path working, and it usually means the sandbox/production mismatch in §4.
