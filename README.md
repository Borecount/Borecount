# Borecount

An embeddable double-entry ledger for JavaScript and TypeScript applications on PostgreSQL.

Borecount is for backend developers and CTOs building products with internal balances.
Use the `@borecount/*` packages to record balanced postings, retry requests without double-posting,
and preserve transaction history through reversals and corrections.

The packages run inside your application. Your team owns deployment, authentication and operations.
Borecount does not move money through banks or payment networks; it records your application's
ledger events. See the [product overview](docs/product/overview.md) and
[known limitations](docs/product/limitations.md).

Explore the [live demo](https://borecount.dev), or run the self-hosted example below.

## Try Borecount: self-hosted

Start with the standalone [self-hosted example](examples/self-hosted/README.md), which consumes
published packages. You need Git, Node.js 22, Docker with Compose v2, and a running Docker engine.
PostgreSQL 16 runs in a container; no separate database installation or commercial account is needed.

```sh
git clone https://github.com/Borecount/Borecount.git
cd Borecount/examples/self-hosted
npm ci
npm run setup
npm run up
npm run check
```

`setup` generates private credentials, builds the images, applies migrations and provisions an
initial tenant. `up` starts the API at `http://127.0.0.1:8082`; `check` should print `health: OK`
and `ready: OK`. The first build needs network access to npm and container registries.

**Next: [make your first posting](docs/integration/README.md#make-your-first-posting).**
The copy-and-run example creates two USD accounts, records a $10 wallet funding event,
retries the identical request and verifies that only two entries exist and the trial balance agrees.

The example keeps its database and generated credentials between restarts. Use `npm run down`
from the same directory to stop it while retaining data. Configuration, additional tenants and
operating procedures are documented in the [example README](examples/self-hosted/README.md).

To embed the packages in your own application after trying them, follow the
[integration guide](docs/integration/README.md#embed-borecount-in-your-application).

## Develop this repository

These commands prepare the package-development database; use the self-hosted route above to try
the product and make a first posting. Repository development requires Bun 1.x and Docker.

1. Start PostgreSQL:
   `docker compose up -d`
2. Copy environment defaults:
   `cp .env.example .env`
3. Install dependencies:
   `bun install`
4. Migrate the local database:
   `bun run db:migrate`

The current schema installs from [one baseline](drizzle/0000_2026-11-09-baseline.sql). Recreate existing development and test databases initialized from any earlier migration chain before running the current migration command. See the [migration policy](docs/integration/versioning.md).

## Test strategy

- `bun run test:unit` runs DB-free unit tests only.
- `bun run test:integration` requires PostgreSQL, verifies `DATABASE_URL_TEST`, resets the test database schema, runs migrations, and then runs the real-PostgreSQL integration suite serially.
- `bun run test:ci` runs the same split sequence that CI uses.
- `bun test` still runs every discovered test file, including integration tests, so only use it when the test database is available.

## Database prerequisites for tests

- Local application DB: `DATABASE_URL=postgresql://luxledger:luxledger@127.0.0.1:5432/luxledger`
- Local test DB: `DATABASE_URL_TEST=postgresql://luxledger:luxledger@127.0.0.1:5433/luxledger_test`

- To prepare only the test database schema locally:
  `bun run db:migrate:test`
- To reset the test database before rerunning integration tests:
  `bun run db:reset:test`
- Integration tests expect a real PostgreSQL instance. `docker compose up -d postgres_test` is enough when you only want the test database.

## CI strategy

- The unit job runs `bun run test:unit` and `bun run typecheck` without PostgreSQL.
- The integration job provisions PostgreSQL 16, checks connectivity, resets the ephemeral test database, runs migrations, and then runs the package integration suite.
- Pull requests must pass `OpenAPI Contract Governance`: deterministic verification fails on runtime/OpenAPI mismatch for governed contract surface.
- Local pre-push contract check: `bun run contract:verify`.

## Repository contents

- `packages/core`: domain model and application contracts.
- `packages/http`: framework-agnostic HTTP contracts and OpenAPI source.
- `packages/fastify-routes`: Fastify route registration package.
- `packages/express-routes`: Express route registration package.
- `packages/postgres-adapter`: Drizzle/PostgreSQL persistence adapter.
- `drizzle`: schema migrations shared by runnable applications.

## API contract

- OpenAPI contract governance policy (CI gating + PR/reviewer process) lives in `docs/governance/openapi-contract-governance.md`.
- [`0.2.0` release and migration notes](docs/releases/0.2.0.md).
- [`0.2.1` coordinated release-readiness notes](docs/releases/0.2.1.md).
- [`0.4.0` coordinated release notes](docs/releases/0.4.0.md).
- Full docs index: `docs/README.md`.
- See API contract: `packages/http/openapi/openapi.yaml`.

## Documentation

- [Product and architecture overview](docs/product/overview.md)
- [Ledger guarantees and invariants](docs/product/invariants.md)
- [Integrator guide](docs/integration/README.md)
- [Versioning, migrations, and publication](docs/integration/versioning.md)
- [Idempotency reference](docs/integration/idempotency.md)
- [Release policy](docs/governance/release-policy.md)
- [Database schema and field semantics](docs/database-schema.md)
- [Known limitations](docs/product/limitations.md)
