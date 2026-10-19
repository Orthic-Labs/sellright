# Decisions

- 2026-10-19: For [#270](https://github.com/Orthic-Labs/sellright/issues/270), filter only Vite-generated `VITE_USER_NODE_ENV` from public-prefixed loader results. Preserve runtime `NODE_ENV` & strict brand schema checks. Legion selected this bounded fix under Adrian’s release-readiness/deployment authorization; real-Vite counterfactual confirmed generation occurs only when legacy NODE_ENV is present.
