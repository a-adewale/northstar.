# Banking Fullstack Project — Northstar

A runnable banking portfolio application by Adewale Adeogun, built around the React, NestJS, TypeScript and MongoDB skills. All funds are simulated.

## Start here (Windows PowerShell)

Open a terminal in this folder:

```powershell
npm.cmd ci
npm.cmd run dev
```

Use Node.js 22 or newer. The first development run downloads a MongoDB binary and starts a temporary **real MongoDB replica set** automatically. No database account or Docker installation is required for this route. Internet access is needed for the first dependency and MongoDB downloads.

- Website: http://localhost:5187
- API health: http://localhost:3100/api/health
- Swagger API explorer: http://localhost:3100/docs
- Sample email: `ada@example.com`
- Sample password: `Northstar123!`

**Temporary development data resets when the database stops.** A new startup restores the sample balances. New registered customers receive two zero-balance accounts. Only the development launcher creates the funded sample customer.

## What you can do

### Paystack test payments

For outgoing demos, select **Paystack Test Bank** and account **1000000001** (prefilled). Bank code 001 uses Paystack's test account lookup, followed by a local ledger simulation; it does not create a payout recipient. Live-bank lookups in test mode have a daily quota, so repeatedly resolving Zenith or other live banks can exhaust that allowance.


- Register and sign in; reload the page without losing a valid session.
- View everyday and savings accounts, hide balances, and navigate the dashboard.
- Review and confirm transfers between your own accounts, from ₦1 to ₦1,000,000.
- Try an outgoing Paystack **test** transfer to another Nigerian bank. The backend resolves the account name and creates a test recipient. If Paystack accepts the transfer, it verifies its status and details before debiting the demo balance. If Paystack rejects third-party payouts because the account is a Starter Business, the app labels the result as a **local demo transfer** and updates only the demo ledger. No real money reaches the destination bank. Only a keyed hash and the last four account digits are stored locally.
- Add money from an external source through Paystack hosted **test** checkout. When offered, select a bank payment option on Paystack. A verified test payment credits the demo account; Northstar account numbers cannot receive ordinary bank transfers.
- See an on-screen notification, updated balances, and refreshed activity after a transfer. Open a transaction in the history table to inspect its receipt details.
- Search descriptions, filter by account or transaction type, and paginate activity.
- Sign out and invalidate the session on the server.
- Use the API explorer to inspect validated request bodies and protected routes.
- An admin-only summary endpoint demonstrates role-based authorization. Public registration always assigns the customer role. Tests verify both role paths; no public admin account is seeded.

## Why these technologies

| Technology | Where it is used | Why |
|---|---|---|
| React | `frontend/src/App.tsx` | Stateful dashboard, filters, authentication forms, and transfer review dialog. |
| TypeScript | Frontend and backend | Checks data shapes and catches integration mistakes before runtime. |
| NestJS | `backend/src/app.ts`, `auth.ts`, `banking.ts` | Controllers, services, dependency injection, guards, validation, and API documentation. |
| MongoDB / Mongoose | `backend/src/database.ts` | Indexed accounts, users, sessions, transfer requests, and ledger entries; transactions protect multi-document changes. |
| JWT + HTTP-only cookies | `backend/src/auth.ts` | Expiring session credential that browser JavaScript cannot read. Server-side session records enable immediate logout revocation. |
| bcrypt | Registration and sign-in | Salted password hashing; plaintext passwords are never stored. |
| Jest / Supertest | `backend/test/banking.spec.ts` | Exercise real HTTP requests against a real temporary MongoDB replica set. |
| Docker Compose / Nginx | Root Compose file and Dockerfiles | Optional repeatable local environment with persistent database storage and a same-origin frontend/API proxy. |

## How a transfer works

1. React gathers the source, destination, amount, and note and opens a confirmation dialog. Amounts are converted to integer kobo, avoiding floating-point money storage.
2. The API checks the session cookie, request origin, input types, amount limits, and ownership of **both** accounts.
3. A MongoDB transaction conditionally debits the source, credits the destination, saves the transfer, and inserts a debit and credit entry. Failure rolls the entire operation back.
4. A unique `(ownerId, key)` index prevents duplicate transfers. Retrying the same request key and body returns its original receipt. Reusing the key with different details returns a conflict.
5. React refreshes balances and transaction history and shows the receipt reference.

Internal transfers move simulated NGN between one customer's accounts. For outward test transfers, the server uses Paystack's account resolution, recipient, transfer, and verification APIs with an `sk_test_` key. A matching successful test transfer updates the demo ledger. On a Starter Business account, Paystack denies third-party payouts; that specific denial triggers a clearly identified local simulation after the recipient was checked. Other provider errors do not debit the balance. Paystack test transfers do not move real money. The demo has no real bank connection, interest calculation, loan service, or live withdrawal endpoint. A live payout system would also need a durable reservation and reconciliation flow, transfer webhooks, and operational review.

## API routes

| Method | Route | Access |
|---|---|---|
| GET | `/api/health` | Public readiness indicator |
| POST | `/api/auth/register` | Public, rate limited |
| POST | `/api/auth/login` | Public, rate limited; sets a cookie |
| GET | `/api/auth/me` | Signed-in customer |
| POST | `/api/auth/logout` | Signed-in customer; revokes session |
| GET | `/api/accounts` | Own accounts only |
| GET | `/api/transactions?accountId=...&kind=credit&search=...&page=1` | Own history; eight rows per page |
| GET | `/api/transactions/:id` | Protected transaction receipt details |
| POST | `/api/transfers` | Own accounts only; UUID request key required |
| GET | `/api/external-transfers/resolve?bankCode=...&accountNumber=...` | Resolve recipient via Paystack test API |
| POST | `/api/external-transfers` | Paystack test transfer; UUID request key required |
| GET | `/api/admin/summary` | Admin role only |

Authenticated write requests require a trusted `Origin` header. The browser supplies it automatically. For curl/API clients using cookies, set `Origin: http://localhost:5187` locally. Swagger runs at `http://localhost:3100/docs` and that origin is also allowed locally.

## Checks

```powershell
npm.cmd run build
npm.cmd test
```

Integration coverage includes unauthorized access, role injection, bad passwords, zero-balance registration, invalid money and IDs, origin protection, cross-customer access, transfer conservation, duplicate prevention, literal search, rollback after ledger failure, admin access, concurrent overdraft prevention, and logout revocation. Test data is created in an isolated temporary MongoDB database.

## Persistent local database

With Docker Desktop available, you can start only the database:

```powershell
docker compose up -d mongo
```

Compose parses the root JWT setting even for a single service, so first create a root `.env` as described below. Copy `backend/.env.example` to `backend/.env` and uncomment its `MONGODB_URI`. The connection uses port **27019** and `directConnection=true` to reach the single-node replica set from your Windows host. Then use `npm.cmd run dev` as usual. This preserves MongoDB data in the named Docker volume.


## Security decisions and remaining scope

Passwords are hashed, cookies are HTTP-only and SameSite Strict, production cookies require HTTPS, inputs reject unknown fields, writes check origins, sessions expire in 30 minutes and are checked server-side, login is rate limited, and headers are set with Helmet. API responses include a generated request ID. No passwords or tokens are placed in localStorage.

This is a __knowledge implementation, not a production banking system__. It does not claim regulatory compliance. Before handling real users or funds, additional work would include MFA, verified email and recovery, durable audit exports, distributed rate limiting, monitoring, backup/recovery, account lifecycle controls, and independent security and financial-system review. The current request rate limiter is process-local. The local temporary database and provided Docker network are development conveniences.

## Project guide

```text
backend/src/
  app.ts          Nest setup, middleware, validation, Swagger
  auth.ts         Registration, sessions, password checks, guards
  banking.ts      Accounts, history, atomic transfers, admin endpoint
  database.ts     MongoDB schemas, indexes, lifecycle
  dto.ts          Runtime request validation and API schema descriptions
  seed.ts         Development-only sample balances
  dev.ts          Local temporary database launcher
  main.ts         Deployment entry point
backend/test/     HTTP integration tests
frontend/src/     React UI and responsive styles
docker-compose.yml
```

Reference documentation: [NestJS authentication](https://docs.nestjs.com/security/authentication), [Mongoose transactions](https://mongoosejs.com/docs/transactions.html).
