# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TakumiPay API is a NestJS-based payment API that enables cryptocurrency payments for digital products (gift cards, game vouchers, etc.). It integrates with blockchain networks for payment verification and external vendor APIs for product fulfillment.

## Common Commands

```bash
# Install dependencies
pnpm install

# Development
pnpm run start:dev       # Watch mode with hot reload

# Build & Production
pnpm run build           # Compile TypeScript
pnpm run start:prod      # Run compiled code

# Testing
pnpm run test            # Run unit tests
pnpm run test:watch      # Watch mode
pnpm run test -- --testPathPattern=<pattern>  # Run specific test file
pnpm run test:e2e        # End-to-end tests
pnpm run test:cov        # Coverage report

# Linting & Formatting
pnpm run lint            # ESLint with auto-fix
pnpm run format          # Prettier formatting

# Database
pnpm prisma generate     # Generate Prisma client (outputs to generated/prisma/)
pnpm prisma migrate dev  # Apply migrations in development
pnpm prisma db seed      # Seed database (runs src/scripts/prisma/seed.ts)
```

## Architecture

### Core Flow: Booking -> Payment -> Purchase

1. **Booking** (`src/booking/`): User reserves a product with price locked via exchange rate. Bookings expire after configurable time (default 15 min). A per-minute sweep (`BookingExpiryService`) expires unpaid ones (never a booking that has a purchase). A payment is judged against the window by CHAIN time only: the contract record's `timestamp` (exposed as `recordTimestamp` by `verifyTransaction`). Mined after `expiresAt` + `BOOKING_PAYMENT_GRACE_MS` (120s) or booking CANCELLED -> no vendor order, points refund via `onOrderRetriesExhausted`, reference failed as `booking_expired`; no record timestamp -> ops (`onPaymentUnverified`), never a refund.
2. **Transaction** (`src/transactions/`): User submits blockchain transaction hash after payment.
3. **Blockchain Verification** (`src/blockchain-verification/`): Verifies transaction on-chain using `viem`. Validates against smart contract state via `getTransactionByRef`.
4. **Queue Processing** (`src/queue/`): BullMQ queues handle async processing - purchase fulfillment, blockchain verification retries, vendor API calls.
5. **Vendor Fulfillment** (`src/providers/vendor-api/`): Calls external vendor APIs (e.g., VCGamers) to deliver digital products.

### Authentication

Two authentication mechanisms running as global guards (`APP_GUARD`):

- **JwtAuthGuard**: JWT-based auth for users. Use `@Public()` decorator to bypass.
- **ApiKeyGuard**: API key auth via `X-API-Key` header. Use `@ApiKeyRequired()` decorator to enforce.

Wallet-based auth uses SIWE (Sign-In with Ethereum). Admin auth uses username/password with argon2 hashing.

### Key Modules

- **PrismaModule**: Database access. Prisma client generated to `generated/prisma/`.
- **ValkeyModule**: Redis-compatible cache (Valkey). Services for nonce caching, rate limiting, vendor API response caching.
- **QueueModule**: BullMQ job queues - `purchase-processing`, `blockchain-verification`, `vendor-api-calls`.
- **BlockchainVerificationModule**: Multi-chain support. Dynamically creates viem clients from database-stored blockchain configs.
- **PointsHoldModule** (`src/points-hold/`): points + tokens in one purchase. `POST /bookings {usePoints}` lets the server pick `pointsApplied` (`computePointsApplied`; `MIN_TOKEN_REMAINDER_USD` = 0.3 is also served as `productPayment.minTokenRemainderUsd`) and takes them at once (`BookingOrder.pointsHoldStatus` HELD, SPEND ledger row, same transaction as the booking). Every transition is a compare-and-set from HELD: CONSUMED by the purchase worker once the payment is verified and in the window, RELEASED (credit + REFUND row) by the sweep (expiresAt + grace + 5 min, no purchase), by `cancelBooking` (refused once a purchase exists) or by a chain verdict. A payment that finds the hold RELEASED places no order (`points_hold_released`); `FulfilmentService.refundAmount` does HELD -> CONSUMED first and refunds token part + points when CONSUMED, token part only when RELEASED. `amountInFiat` is the token part only.
- **AppConfigModule** (`src/app-config/`): public `GET /app-config` -> `{ productPayment: { mode } }`, from env `PRODUCT_PAYMENT_MODE` (`TOKEN` default | `POINTS`; empty or invalid = `TOKEN`). The mode only decides what clients offer; `/bookings`, `/purchases`, `/redeem` and `/points` stay live in both.

### Fulfilment leg (vendor accepted ≠ delivered)

- **FulfilmentModule** (`src/fulfilment/`): after `createOrder` the money leg (`PurchaseStatus` / `RedemptionStatus`) is done; `fulfilmentStatus` (`QUEUED → SUBMITTED → DELAYED? → DELIVERED | FAILED | NEEDS_RECONCILE | REFUNDED`) tracks whether the vendor actually handed the product over. A `fulfilment-check` BullMQ chain polls `getOrderStatus` with backoff (15s … 1h, 24h cap); `FulfilmentSweeperService` re-arms lost chains every 10 min. Every transition is a compare-and-set on `fulfilmentStatus`, so the poller, sweeper, read path (`isWorthChecking`) and admin can all apply the same vendor answer safely. The "ready" push fires only on vendor terminal success. **Provider-agnostic:** the core only speaks the fulfilment port on `BaseVendorService` (`vendorName`, `checkOrder → {outcome, raw, response}`, `classifyOrderFailure → definitive|ambiguous`) and resolves the adapter per order via `VendorRegistry` from `productPrice.vendor.name`. Status codes and body shapes stay inside adapters (`implementations/vcgamers/vcgamers-status.ts`; VCGamers' failure code is unconfirmed there). Adding a PPOB provider = one adapter + one registry line.
- **Refunds are points** (`src/points/points-refund.service.ts`, 1 pt = Rp 1): only *definitive* vendor failures auto-refund; timeouts/5xx/lost responses go to `NEEDS_RECONCILE` for ops (`/admin/fulfilment`). Over-cap, breaker-tripped and unknown-amount refunds are held as `FulfilmentRefund(PENDING_REVIEW)`. Balance moves are atomic increments inside one transaction with the CAS; `PointTransaction` is a hypertable so the CAS + unique `FulfilmentRefund.<target>Id` are the idempotency guards. A delivery observed after a refund sets `deliveredAfterRefundAt` (clawback via `reverse`).
- **Delivery parsing** (`src/delivery/`): vendor `voucher_code` is free-form. Server parses it into one `DeliveryPayload` (`primary / fields / raw / parse / parserId`) that mobile renders generically. Tiers: `Product.voucherTemplate` (ops-editable, no deploy) → code parsers (`pln.parser.ts`) → heuristic → raw only. `raw` is always kept; `pnpm backfill:delivery [CODE]` re-parses history. `VoucherShape` logs every distinct shape per product so ops knows which brands still need a template.

### Notifications

- **PushModule** (`src/push/`): `NotificationLog` outbox → `push-dispatch` BullMQ worker → Expo. Every push carries a `category` (`notification-categories.ts`) that users can mute via `PATCH /users/me/notification-preferences`; `GET /users/me/notifications` is the inbox. A `dedupeKey` on the outbox row makes the same event from two producers one notification (unique index, `createMany(skipDuplicates)` so it is safe inside a caller's transaction).
- **WalletActivityModule** (`src/wallet-activity/`): on-chain activity for every held wallet via Zerion transaction-subscription webhooks (`POST /webhooks/zerion/transactions`, RSA-verified). `ZerionSubscriptionSyncService` keeps one subscription equal to all push-registered wallets × all active `Blockchain` rows that map in `ZERION_CHAINS`. `wallet-activity.classifier.ts` is the pure payload→copy function (swap = one push, approvals = own category, failed txs). The callback host must be whitelisted in the Zerion dashboard.

### Vendor API Pattern

New vendor integrations extend `BaseVendorService` in `src/providers/vendor-api/base/`. Current implementation: VCGamers (`src/providers/vendor-api/implementations/vcgamers/`).

### Database

PostgreSQL with Prisma ORM. Schema at `prisma/schema.prisma`. Uses ULID for IDs. TimescaleDB extension for `ExchangeRate` time-series data.

#### TimescaleDB Hypertables — FK Rule

The following tables are TimescaleDB hypertables:

| Table | Partitioned by |
|---|---|
| `TransactionHistory` | `createdAt` |
| `PointTransaction` | `createdAt` |
| `AdminAuditLog` | `createdAt` |
| `ExchangeRate` | `createdAt` |

**NEVER add a `FOREIGN KEY ... REFERENCES <hypertable>` constraint in migration SQL.**
TimescaleDB stores hypertable data in chunks under the `_timescaledb_internal` schema. Any FK targeting a hypertable causes a Prisma P4002 introspection error (`cross schema references are only allowed when the target schema is listed in the schemas property`).

Rules:
- Hypertable rows use composite PKs `(id, createdAt)` — store both columns in referencing tables.
- Enforce referential integrity at the **application level** (lookup before insert, idempotency checks).
- Run `bash scripts/lint-migrations.sh` after writing a migration to catch violations before applying.

## Environment Variables

Key variables (see `.env.example`):

- `DATABASE_URL`: PostgreSQL connection string
- `VALKEY_HOST/PORT`: Redis-compatible cache
- `JWT_SECRET`, `JWT_EXPIRATION_TIME`: Auth tokens
- `ADMIN_WALLET_PRIVATE_KEY`: For blockchain transaction signing (must be 0x-prefixed, 66 chars)
- `SIWE_DOMAIN/URI/STATEMENT`: Sign-In with Ethereum config
- `VCGAMERS_SECRET`: Vendor API credentials

## Decorators

- `@Public()`: Skip JWT auth
- `@ApiKeyRequired()`: Require X-API-Key header
- `@Roles(UserRole.ADMIN)`: Require specific user role
- `@RateLimit()`: Apply rate limiting

## Swagger

API docs available at `/docs` when running. Configured in `src/config/swagger.config.ts`.
