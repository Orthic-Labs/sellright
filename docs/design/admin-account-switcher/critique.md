# Separate design critique · issue 355

## Brief and source truth

Let an admin switch among saved accounts from one web-admin dropdown, across unrelated SellRight server origins, then choose only stores authorized under selected account. Preserve current admin navigation. All identities, servers, stores, counts, orders, and money shown in prototype are illustrative.

Current web UI has one authenticated identity and a separate store-slug switcher. Architecture review recommends account slots keyed by canonical server origin + admin identity, with a central admin client/BFF and encrypted server-side target-session vault. Each target server remains authority for its session, MFA/passkey, roles, and `stores[]`. Browser should hold only hub session; hub never collects target passwords. Prototype does not implement authentication, vault, or BFF.

RightSites’ five storefront hosts are not five admin accounts; no account is pre-seeded per public site. Generic examples use `.sample.invalid` hosts.

Brand source selects approved vertical SellRight mark in `#45D483` on `#101A14`; existing admin fonts are Hanken Grotesk, Schibsted Grotesk, and JetBrains Mono.

## Parameter vector

- Control pattern: header menu
- Account identity: canonical target origin + email
- Store scope: nested under selected account, filtered by per-account permissions
- Density: compact; current account + store stays visible
- Shell: existing dark rail + light work area
- Signal: green = current/focus/brand; amber = expired; red = request failure
- Motion: no extra animation
- Viewports: desktop, 390 px, and 320 px responsive surfaces
- A11y: native controls; visible focus; Escape closes; focus trap + return for dialogs; live status
- Security truth: forms are illustrative; no credential or backend calls

## Candidate scores

Scores 1–5 against origin clarity, store scoping, repeat speed, navigation preservation, and recovery states.

| Candidate | Origin clarity | Store scoping | Repeat speed | Navigation preserved | Recovery states | Total /25 |
|---|---:|---:|---:|---:|---:|---:|
| Identity rail | 5 | 4 | 4 | 4 | 3 | 20 |
| Header switcher | 5 | 5 | 5 | 5 | 5 | 25 |
| Workspace tray | 5 | 5 | 3 | 4 | 4 | 21 |

## Winner

**Header switcher.** Its saved-account rows show server hostname + email, so the same email at `admin.sample.invalid` and `ops.sample.invalid` remains visibly distinct. Store choices appear beneath selected account and show role; one account with five permitted stores remains one account. This keeps repeated switches in one page while preserving existing navigation.

Production account enrollment opens the selected target origin for passkey/MFA sign-in, then returns to central admin. Saved-account switching stays in one dropdown after enrollment. BFF/vault is architecture recommendation only; no prototype action implies sign-in succeeded.

## Critique findings & states represented

- **P1 — origin identity:** email alone can collide across servers. Every account row includes canonical origin; duplicate Alex accounts demonstrate two server identities.
- **P1 — tenant context:** stores are scoped per selected account; menu rebuilds store list from its account map and restores that account’s last valid store.
- **P1 — stale data:** sample orders and totals appear only for Alex at Northwind; other contexts show no-data placeholder, never prior account data.
- **P1 — pending work:** account/store switch opens keep-editing or discard confirmation.
- **P1 — expired target auth:** Sam’s expired row identifies its origin. Reauth dialog fixes target hostname + read-only email, leaves active account in place, and never claims success.
- **P1 — enrollment truth:** Add-account dialog collects only a blank target server URL. Continue explains production target-origin passkey/MFA handoff and return; this prototype does not navigate. Reauth shows fixed target hostname + read-only email. No target password is collected; dialogs do not authenticate or add an account.
- **P2 — request failure/loading:** status feedback says switching, retains active context on error, and exposes recovery direction.
- **P2 — keyboard:** controls are native buttons/inputs, focus is visible, Escape cancels dialogs/closes menu, dialog traps focus and returns it on cancel.
- **P2 — viewport:** menu has bounded scrolling; header/intro compress at 390/320 px; primary mobile header controls retain 44 px targets.

## Limits of evidence

This is a source-grounded design proposal, not a product behavior claim. Parent owns browser render review and integration checks. No backend, credential store, or API is implemented here.
