# SellRight — Licensing (2026-06-10)

> **DISAMBIGUATION (added 2026-06-13 — read before editing):**
>
> This document covers **licensing SellRight-the-backend to external operators** — the per-instance Ed25519 signed-blob scheme, store-count metering, and degrade-not-revoke enforcement. This is a **future productization concern**; the scheme described below is **entirely unbuilt** (status: internal now, product later — see §1).
>
> It is **distinct** from the **catalog/app-licensing subsystem** that IS built (commit 43ebcbb): `packages/api/src/licensing/`, migration `0027_software_entitlements.sql`, `routes/apps.ts`, and `docs/RIGHT-APPS-SELLRIGHT-SETUP.md`. That subsystem sells app licenses as catalog products for Right Apps (HeardRight, ViewRight, etc.) and uses **opaque bearer activation tokens**, not the Ed25519 signed-blob scheme designed in this doc. Both are real; they address different things.

*Status: **internal now, product later** (Adrian, 2026-06-10). SellRight is currently unlicensed internal infrastructure powering DD/RH/TS/SS. Nothing below exists in code, and nothing should be built until the productization trigger in [STRATEGY-MOAT-POSITIONING.md](STRATEGY-MOAT-POSITIONING.md) §6 fires (all four brands live ≥ one quarter). This doc adapts the Right Suite licensing standard ([MailRight LICENSING.md](../../../mailright/docs/fable/LICENSING.md)) to SERVER software so the design is decided before it's needed.*

---

## 1. Current state (internal)

- No license, no entitlements, no gating. The repo is private; the four brands are the only tenants.
- If code is ever shared (contractor, second maintainer), it remains proprietary — do NOT add an OSS license file casually; an MIT/Apache header forecloses the commercial path the same way Vendure's GPLv3 forecloses ours.
- What must change before productization: everything in §2–§6 below, plus an entity decision (who sells) and MoR onboarding — same open items as MailRight §9.

## 2. Why the desktop model doesn't transfer

The Right Suite standard binds a signed blob to a **device UUID** on a user's machine. A server backend has no "device," is often containerized/re-provisioned, and — critically — **holds other people's revenue and customer data**. The adaptation principles:

1. **Per-instance keys, not per-device.** `"app": "sellright"`, `instance_id` instead of device UUID.
2. **Offline-tolerant validation** — license checks must never be in the request path.
3. **Failure ≠ revocation** — only an authenticated "revoked" response downgrades.
4. **NO kill-switch on merchant data, EVER.** An ecommerce backend that bricks on license failure destroys someone's store. Expiry degrades to **read-only admin; the storefront APIs and checkout NEVER stop.** Orders keep flowing, money keeps settling, data export always works. The license gates the operator's convenience surface, not the merchant's business.

## 3. License format — signed blob, per-instance

Same Ed25519 + canonical-JSON scheme as the suite standard, with server claims:

```json
{
  "v": 1,
  "app": "sellright",
  "id": "lic_…",
  "email": "operator@example.com",
  "tier": "self_hosted" | "self_hosted_pro" | "hosted",
  "kind": "sub" | "decade",
  "instance_id": "inst_<uuid>",      // generated at install, stored in DB (license table), not hardware-derived
  "limits": { "stores": 10 },        // tier-enforced tenant count — the natural server metering axis
  "issued": 1781136000,
  "expires": 1812672000,
  "sig": "<Ed25519 over canonical JSON>"
}
```

- `instance_id` replaces device UUID: random UUID minted on first boot, persisted in a `license` table (one row), included in the signed payload at activation. A blob copied to another instance fails signature-vs-instance check.
- **Metering axis is `stores` (tenant count), not seats** — it matches the multi-tenant architecture and is checkable in one SQL count. Admin staff seats stay unlimited (per-action permissions already exist; don't double-meter).
- Verification offline against a compiled-in public key (same `rightkit-license` concepts, Node port). Suite signing key + `app` claim per MailRight §8.

## 4. Validation & enforcement — server semantics

| Event | Behavior |
|---|---|
| Boot, no network | Verify blob offline; serve normally. |
| Periodic refresh (daily, async job — never request-path) | `POST /refresh {license_id, instance_id}` → current blob. Picks up renewals/revocations. Sends nothing else (no GMV, no order counts, no telemetry smuggling). |
| Refresh failing (server down, firewall) | Subs: 30-day grace past expiry. Decade: 60 days past last successful check → **admin banner only**. Never degrade on failure. |
| Authenticated `revoked` / expired past grace | **Degrade, don't kill:** admin becomes read-only (no catalog edits, no settings writes). Storefront, checkout, payments, webhooks, fulfillment of in-flight orders, and full data export remain untouched. |
| Store count exceeds tier limit | Block creating store N+1; existing stores unaffected. |
| License server shut down permanently | Last-known-good blobs valid forever (decade) / through term (subs). Failure ≠ revocation. |

Enforcement point: one middleware on admin **write** routes (`/v1/admin/*` POST/PUT/PATCH/DELETE) consulting cached `Entitlements` from the daily job — mirrors how the CSRF middleware is registered in `app.ts:31`. Shop routes (`/v1/shop/*`) have **no license code path at all**, by design: the strongest guarantee is the check not existing where it could hurt a merchant.

Threat model follows MailRight §5.2: server operators can patch the binary/source even more easily than desktop users — accepted by design. Honest-operator enforcement; the periodic check handles refunds/leaks/sharing; don't escalate to DRM that risks merchant data.

## 5. Tiers (sketch — price at activation time, not now)

| Tier | Shape |
|---|---|
| **Self-hosted** | Annual or decade key, N stores, community support. The Right Suite anti-rent signature (decade option) carries over. |
| **Self-hosted Pro** | Higher store limit, priority support, maybe early gateway modules. |
| **Hosted** | We run it (the Hetzner playbook is the runbook). Different economics entirely — defer. |

Decade caveat from the suite standard applies double for servers: never bundle an ongoing-cost service (hosted anything, tax-rate feeds) into a fixed-price decade key.

## 6. What productization requires beyond licensing

Entity + MoR (Paddle/Lemon Squeezy, per MailRight §2), license Worker reuse (one suite Worker, `app:` prefix — MailRight §8 already plans this), docs/onboarding for a stranger to self-host, and a security re-audit — the audit's §4 list is table stakes before anyone else's revenue runs on this code.
