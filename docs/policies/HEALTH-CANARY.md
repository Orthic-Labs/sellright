# Health canary (POST /v1/admin/system/canary)

Status: implemented in sr-canary lane (not committed). Spec: PLAN 7.16, interface I-8, decisions X-34 and X-38.

## Purpose

Prove delivery end to end on demand. Each channel is enqueued through the same outbox code that serves real traffic, so a canary that reaches `sent` / `delivered` has exercised the production template, transaction, retry and SMTP/webhook/APNs path. Canary rows are excluded from customer metrics by the reserved marker.

## Request

`POST /v1/admin/system/canary`, installation administrator only (owner role is refused with 403). Store is selected with the usual store header.

```json
{ "slot": 7, "channels": ["email", "webhook", "push"], "kinds": ["order_confirmation", "trial_license_key", "shipping_notification", "password_reset"] }
```

- `slot`: non-negative integer, echoed back. The monitor uses the 15-minute slot.
- `channels`: unique subset of `email`, `webhook`, `push`.
- `kinds`: email kinds only, requires `email` in `channels`. Default: all four.

Response `200`:

```json
{ "slot": 7, "rows": [ { "channel": "email", "kind": "order_confirmation", "id": "<email_outbox.id>" }, { "channel": "webhook", "id": "<webhook_delivery.id>" } ], "skipped": [ { "channel": "push", "reason": "push_jobs_disabled" } ] }
```

## Recipients

Only `store.config.health.canary`:

| Field | Used by | Refused with (422) when missing |
|---|---|---|
| `email` | all email kinds (recipient) | `canary_email_not_configured` |
| `webhookUrl` | one canary endpoint (`topics = ['health.canary']`), created on first use | `canary_webhook_not_configured`; `canary_webhook_url_unsafe` if the SSRF guard refuses it |
| `pushToken`, `pushEnvironment` | one `push_outbox` row | `canary_push_not_configured` (only when push jobs are on) |

Nothing is addressed to a customer or a merchant subscription. All validation runs before the first insert, so a refusal leaves no partial rows.

## Kinds

| Kind | Template | Outbox kind | Note |
|---|---|---|---|
| order_confirmation | `orderConfirmation` | `order_confirmation` | |
| trial_license_key (license delivery) | `trialLicenseKey` | `trial_license_key` | Production sends this inline through `sendTrialKey` (`routes/apps.ts`), not through the outbox. The outbox kind exists for the canary only. See open items. |
| shipping_notification | `shippingNotification` | `shipping_notification` | |
| password_reset | `passwordReset` | `password_reset` | Fixture URL, no real token. |

Fixture data is fixed (`CANARY-ORDER-0001`, `CANARY-FIXTURE-KEY-0000`, and so on) so runs are comparable.

## Reserved marker

Canary rows carry `canary: true` and `marker: "health.canary"` in the stored payload (email, webhook, push). Enforcement lives in `src/canary/marker.ts`:

- `enqueueEmail`, `enqueuePush`, `emitEvent` refuse a payload with a `canary` key or `marker: "health.canary"` unless called from the internal canary path.
- `emitEvent` never fans out topic `health.canary`, so `'*'` subscribers never receive it.
- Merchant webhook create and patch refuse `health.canary` in `topics` (400 `reserved_topic`).
- Email payloads are stripped of `canary` and `marker` before SMTP.

## Rate limit

One emit per channel per minute per store (`canaryRetryAfter` / `recordCanaryEmit`, bucket `health-canary`). A breach returns `429` with `retryAfterSeconds`. The budget is recorded only after a successful emit.

## Judgement (PLAN 7.16 / X-34)

- Email: judged on the outbox row reaching `sent`. Retries follow `email/outbox.ts` (backoff 60, 300, 1800, 7200 s, 5 attempts).
- Webhook: judged on the delivery reaching `delivered`. Retries follow `webhooks/emit.ts`.
- Push: judged on `sent`, only while `JOBS_PUSH_ENABLED=1`. While off, the push channel is N/A and is reported in `skipped`.

## Open items

1. Production trial-key delivery is inline (`sendTrialKey`), so the canary exercises template, outbox and SMTP but not the production trigger. Moving it onto the outbox is a product change and is not part of this lane.
2. The canary webhook receiver must be reachable at a public address. `safeOutboundFetch` refuses private and loopback hosts, so a receiver on `localhost` cannot be used without an SSRF policy change. Unverified: the monitor's host name and address.
3. Store-level `appKey` is not passed to canary renders (the store has no single app key), so canary emails use config or env sender and storefront values.
