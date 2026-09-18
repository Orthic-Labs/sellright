# SellRight

A self-hosted, multi-store commerce backend with a REST API and browser-based admin.

SellRight keeps catalog, carts, checkout, payments and order operations in one PostgreSQL-backed system. Storefronts consume its API independently; there is no bundled customer storefront in this repository.

**Status: pre-1.0.** Suitable for development and evaluation. Production adoption requires gateway acceptance, migration rehearsal, backups and rollback verification. Implemented adapters are not a claim that every merchant deployment has passed acceptance.

## What Is Included

- Products, variants, collections, inventory, promotions, shipping and tax.
- Persistent carts separate from orders, with server-authoritative prices and checkout.
- Stripe, NMI and Sezzle adapters, payment reconciliation and refunds.
- Customer accounts, orders, returns, fulfillment and transactional email.
- Multi-store administration with staff permissions and PostgreSQL row-level security.
- REST/OpenAPI, static catalog exports, a Vendure importer and software licensing.

See [architecture](docs/ARCHITECTURE.md) for boundaries and [features](docs/FEATURES.md) for detail.

## Run With Docker

Use a host with Docker Compose and ports 80/443 available. For an existing reverse proxy, adapt the edge routing rather than taking over those ports.

1. Clone this repository and enter its directory.
2. Copy `deploy/.env.example` to `deploy/.env`. Set the domain, store details and independently generated passwords/secrets.
3. Create `deploy/gateway-accounts.json` containing `[]` until configuring NMI or Sezzle. Never commit merchant keys. See [gateway account examples](deploy/gateway-accounts.example.json).
4. Point the configured hostname at the host, then run:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

The stack includes PostgreSQL, the API, admin and TLS proxy. Migrations/bootstrap use the database owner; HTTP requests use a separate non-owner role. Bootstrap is create-only and does not reset existing passwords on restart.

Read the [operations and restore runbook](docs/runbooks/production-compose.md) before relying on the deployment. This starts the backend/admin, not a customer storefront.

## Develop

Use Node.js 24 and the exact pnpm version in `package.json`. PostgreSQL 17 is the integration-test target.

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/admin install --frozen-lockfile
```

Copy the package-local `.env.example` files to `packages/api/.env` and `packages/admin/.env`. Configure a development database and a non-owner runtime role using the [database-role runbook](docs/runbooks/postgres-app-role.md). Use the schema owner only for migrations/bootstrap.

```sh
pnpm --filter @sellright/shared build
pnpm --filter @sellright/api build
DATABASE_URL='<schema-owner-url>' pnpm --filter @sellright/api db:migrate:runtime
pnpm --filter @sellright/api dev
```

Replace the migration URL placeholder with your development schema-owner connection. Keep the API's package-local `DATABASE_URL` on the runtime role. Run the admin in another terminal with `pnpm --dir packages/admin dev`. The API contract is at `http://localhost:3300/v1/openapi.json`. First-store bootstrap requires `BOOTSTRAP_STORE_SLUG`, `ADMIN_EMAIL` and `ADMIN_PASSWORD`; with those configured, run `pnpm --filter @sellright/api bootstrap:runtime` using the schema-owner connection. See the [deployment example](deploy/.env.example).

## Verify

```sh
pnpm verify:static
pnpm --dir packages/admin test
pnpm deps:audit
```

Database tests require a dedicated disposable `*_test` database. They can truncate fixture tables: never point them at a development clone or production. After provisioning/migrating that test database, run `pnpm --filter @sellright/api test:db` and `pnpm verify:db`. Provider-enabled tests have additional opt-in guards.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Email delivery](docs/EMAIL.md)
- [Migrations](docs/runbooks/migrations.md)
- [Deployment, backup and restore](docs/runbooks/production-compose.md)
- [Isolated synthetic demo](deploy/demo/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

SellRight is source-available under the **Business Source License 1.1**, not an OSI Open Source license before its Change Date. Production use is free for organizations with no more than **25 Covered Persons**, as defined in [LICENSE](LICENSE); larger organizations require a commercial license. Each version converts to Apache-2.0 on its Change Date. The license text is authoritative.
