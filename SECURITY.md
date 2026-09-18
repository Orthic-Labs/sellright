# Security

## Report Privately

Use [GitHub private vulnerability reporting](https://github.com/Orthic-Labs/sellright/security/advisories/new) for security issues. Do not post exploitable details, credentials or customer data in public issues.

Include the affected commit/version, reproduction steps using synthetic data, expected behavior and impact. Redact tokens, cookies, database URLs and merchant credentials. Do not test against a third party's store.

## Supported Versions

SellRight is pre-1.0. Security fixes target the current main branch; older snapshots do not have a separately maintained security-support promise. Review migrations and test changes before upgrading a running store.

## Deployment Responsibilities

- Use a non-owner, non-superuser PostgreSQL role without BYPASSRLS for the API.
- Keep owner credentials, payment keys and environment files private.
- Keep demo data isolated from real stores and disable real payments and outbound mail in public demos.
- Maintain off-host backups and prove restore procedures.
- Treat repository checks as evidence about the tested revision, not certification of a deployment.
