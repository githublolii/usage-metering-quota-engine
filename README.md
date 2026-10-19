# Usage Metering & Quota Engine

![Node](https://img.shields.io/badge/Node-%E2%89%A520.11-339933) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%2B-4169E1) ![Tests](https://img.shields.io/badge/tests-127%20passing-2EA44F) ![License](https://img.shields.io/badge/license-MIT-blue)

A multi-tenant **usage metering and quota engine** in TypeScript + PostgreSQL.

```
Zero quota overruns · Zero deadlocks · Zero double-spending · Exactly-once decisions
```

The **account plan** and the **user plan** apply simultaneously to every
consumption request. Decisions run under pessimistic row locks in a
deterministic lock order, idempotency is enforced by the database, usage is
tracked as monotonic counters with implicit UTC monthly rollover, errors are
RFC 7807 `problem+json`, and the quota policy lives in a pure, exhaustively
tested function. A web dashboard drives all of it.

### Requirement verification

Every guarantee in this repository has a one-command reproduction:

| Requirement | Implementation | Verification |
|---|---|---|
| **Concurrency safety** — no over-allocation under parallel load | Pessimistic `FOR UPDATE` row locks + deterministic account→user lock order (`src/modules/metering/`) | `npm run test:concurrency` |
| **Idempotent retries** — zero double-charge, even racing | `UNIQUE (account_id, request_id)` + replay fast path + 23505 abort-and-replay + **request fingerprinting: key reuse with a different payload is a 409** | `npm run test:idempotency` |
| **Mid-month plan changes** — usage preserved, remaining clamps to 0 | Monotonic counters; `remaining = GREATEST(0, allowance − consumed)` derived, never stored | `npm run test:plan-change` |
| **Tenant isolation + hashed API keys** | SHA-256 digests; every query scoped by `account_id`; foreign resources are indistinguishable from nonexistent | `npm run test:security` |
| **Monthly reset / previous months** | Period is part of the row key — implicit UTC rollover, frozen history | `npm run test:monthly-reset` |
| **Boundary rejection correctness** | Pure evaluator unit-tested at limit−1 / limit / limit+1 × all 4 rules | `npm run test:boundary` |
| **Randomized property-based invariants** | fast-check oracle cross-checks: pure evaluator vs an independent model (1,000 runs) + live-API streams with mid-stream plan flips | `npm run test:property` |
| **Performance report** | 500-way storms with SQL-verified invariants | `npm run load-test` → [`perf/results/`](./perf/results/) |
| **The whole suite** | 127 tests, self-contained embedded PostgreSQL | `npm test` |

---

## Table of contents

1. [Quick start](#quick-start)
2. [The web dashboard](#the-web-dashboard)
3. [API reference](#api-reference)
4. [Error standards (RFC 7807)](#error-standards-rfc-7807)
5. [How a consume decision executes](#how-a-consume-decision-executes)
6. [The four invariants](#the-four-invariants)
7. [Security & correctness model](#security--correctness-model)
8. [Performance results](#performance-results)
9. [Decisions on open questions](#decisions-on-open-questions)
10. [Testing](#testing)
11. [Project structure](#project-structure)
12. [Configuration](#configuration)
13. [Design decisions & trade-offs](#design-decisions--trade-offs)
14. [Production deployment](#production-deployment)
15. [Documentation map](#documentation-map)
16. [License](#license)

---

## Quick start

No Docker, no database setup, no environment variables — one prerequisite:
**Node.js ≥ 20.11**.

```bash
npm install

# ▶ The website: full dashboard UI on http://localhost:3000
#   (boots its own embedded PostgreSQL, migrated + seeded automatically)
npm run serve

# The six-phase guided walkthrough in your terminal (self-hosting, same trick)
npm run demo

# The full test suite — 127 tests, each run boots a pristine embedded PostgreSQL
npm test

# The concurrency benchmark — 500-way storms, invariants verified against SQL
npm run load-test
```

Prefer your own PostgreSQL (or Docker Compose)? See
[Production deployment](#production-deployment).

---

## The web dashboard

`npm run serve` → **http://localhost:3000** — a dependency-free dark-themed
dashboard (vanilla HTML/CSS/JS, CSP-safe) driving the real API:

| Panel | Capabilities |
|---|---|
| **Provisioning** | Create a tenant bound to Starter/Pro; the API key is shown **exactly once** with copy & adopt |
| **Account** | Live usage bar, runtime **plan switching** (no restart, usage preserved), **key rotation** |
| **Live usage** | Account + per-user budget bars, color-coded green → amber → red at the boundary |
| **Users** | Register users with a plan picker (Basic/Premium/custom) |
| **Consume console** | Real decisions with visible `requestId`, **Replay last** (idempotency demo), **⧉ Copy as cURL** (reproduce any request in a terminal), and a **raw JSON inspector** showing the exact payload the API returned |
| **Consumption timeline** | Canvas chart: per-request units (accepted/rejected) + cumulative accepted line — no chart libraries |
| **Chaos / stress mode** *(directly under the chart — run a storm, watch the timeline fill in)* | Fire up to 500 concurrent requests at the live engine from the browser; invariants (zero transport errors, conservation, no overrun, exact budget exhaustion) verified against database totals |
| **Safe-retry proof** | One click sends 1 original + 2 identical retries (simulated dropped connection); verifies same status, identical payload, `X-Idempotent-Replay: true`, and usage moved **exactly once** — zero double-charge |
| **Time machine** | UTC month selector on Live usage + History: previous months read as frozen history, the next month reads as **zero** — monthly rollover demonstrable without touching the system clock |
| **History** | Paginated audit trail with accepted/rejected chips and rule columns |
| **Guided scenario walkthrough** | One click provisions a fresh account and runs the complete product story — different-plan users → accepted action → user-limit rejection → shared-account-limit rejection → plan switch — every step auto-asserted, then adopts the account |
| **Interactive API explorer** | Swagger UI at **`/docs`** over a hand-authored OpenAPI 3 spec (all 15 operations, schemas + examples); raw spec at `/openapi.json` |

---

## API reference

All authenticated routes accept `X-API-Key: <key>` or
`Authorization: Bearer <key>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | — | Web dashboard |
| `GET` | `/docs` | — | **Interactive API explorer** (Swagger UI over the OpenAPI spec) |
| `GET` | `/openapi.json` | — | Raw OpenAPI 3 specification |
| `GET` | `/health` | — | Process + database liveness |
| `POST` | `/accounts` | — | Provision account; returns the API key **once** |
| `GET` | `/accounts/me` | ✔ | Profile, bound plan, live usage for the current UTC month |
| `POST` | `/accounts/rotate-key` | ✔ | Atomically invalidate the old key, issue a new one |
| `PATCH` | `/accounts/plan` | ✔ | Runtime plan mutation (no restart; usage preserved) |
| `GET` | `/plans` | ✔ | Predefined catalog + this account's custom plans |
| `POST` | `/plans` | ✔ | Create a custom plan (tenant-scoped) |
| `PATCH` | `/plans/:id` | ✔ | Update a custom plan owned by the caller (limits/name; type immutable) |
| `DELETE` | `/plans/:id` | ✔ | Delete a custom plan — 409 while any account/user is still bound |
| `POST` | `/users` | ✔ | Register a user under this account |
| `GET` | `/users` | ✔ | List this account's users |
| `PATCH` | `/users/:userId/plan` | ✔ | Runtime user plan mutation (usage preserved) |
| `POST` | `/metering/consume` | ✔ | **The quota decision** (idempotent via `requestId`) |
| `GET` | `/metering/usage?userId=&period=` | ✔ | Usage views (account + optional user) |
| `GET` | `/metering/history?userId=&period=&accepted=&limit=&offset=` | ✔ | Paginated audit trail |

### The consume contract

Request (strict — unknown fields are rejected):

```json
{ "userId": "user-1", "units": 10, "requestId": "7c9e6679-7425-40de-944b-e07fc1f90ae7" }
```

Accepted — `200 OK`:

```json
{
  "accepted": true,
  "requestId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "period": "2026-10",
  "unitsConsumed": 10,
  "usage": {
    "account": { "planName": "Starter", "planType": "ACCOUNT", "monthlyAllowance": 100,
                 "maxUnitsPerRequest": 10, "unitsConsumed": 10, "remaining": 90 },
    "user":    { "planName": "Basic", "planType": "USER", "monthlyAllowance": 100,
                 "maxUnitsPerRequest": 20, "unitsConsumed": 10, "remaining": 90 }
  }
}
```

Rejected — `422 Unprocessable Entity` (**zero units consumed**, all-or-nothing):

```json
{
  "accepted": false,
  "requestId": "c4b3…",
  "reason": "Request exceeds user maximum units per request limit.",
  "violation": { "source": "user", "rule": "max_units_per_request",
                 "limit": 20, "requestedUnits": 25, "currentUsage": 10,
                 "remainingMonthly": 90 },
  "period": "2026-10"
}
```

Every violation additionally carries **`remainingMonthly`** — the violated
entity's remaining monthly budget at decision time (`GREATEST(0, allowance
− usage)`) — so a client can render "you have 90 units left this month"
without a second API call. Useful even when the violated rule is
per-request. Full plan context (names, limits, live usage for both plans)
is one `GET /metering/usage` away.

**Idempotency:** retrying the same `requestId` returns the original decision
with the original status code and `X-Idempotent-Replay: true`. Replays of
committed decisions are served by a **pre-transaction fast path** — a plain
indexed read, no `BEGIN`, no locks, no convoy. If the retry *races* the
original, the loser aborts on `UNIQUE (account_id, request_id)` with its
counter increments fully rolled back. Reusing a key with a **different
payload** (`userId` or `units`) is rejected with **409** — one idempotency
key maps to exactly one request. For a *new* decision after a plan upgrade,
use a *new* `requestId`.

---

## Error standards (RFC 7807)

Every error response is `application/problem+json` with a stable `type` URN,
human `title`/`detail`, the request path as `instance`, and — for validation —
a structured `errors[]` array. Stack traces and SQL never leave the server.

| HTTP | `type` URN | Emitted when |
|---:|---|---|
| `400` | `…errors:VALIDATION_FAILED` | Request violates a Zod DTO (with `errors[]`: path + message per issue), or the body is not valid JSON |
| `401` | `…errors:UNAUTHENTICATED` | Missing or unknown API key |
| `404` | `…errors:NOT_FOUND` | Resource unknown **within the authenticated tenant** (cross-tenant probes are indistinguishable from nonexistent — IDOR-safe) |
| `409` | `…errors:CONFLICT` | Duplicate user, duplicate plan name, wrong plan type binding — or an idempotency key reused with a different request payload |
| `422` | *(quota payload)* | **Not an error**: a well-formed request violating quota policy. The body is the business decision envelope above — a rejection is a *successful* decision, not a transport failure |
| `500` | `…errors:INTERNAL` | Unexpected failure. Generic body; details only in server logs |

The domain owns status semantics: typed `DomainError`s in
`src/domain/errors.ts` carry their own HTTP status; exactly one renderer
(`problemDetailsHandler`) turns them into responses. Controllers never
invent status codes, and validation errors never echo raw input values back
(log-injection safety).

---

## How a consume decision executes

```mermaid
sequenceDiagram
    participant C as Client
    participant MW as auth + validate
    participant S as metering.service
    participant DB as PostgreSQL

    C->>MW: POST /metering/consume {userId, units, requestId}
    MW->>S: ConsumeDto + AuthContext (SHA-256-resolved tenant)
    S->>DB: ⓪ probe (account_id, request_id) — read-only, NO transaction
    alt committed decision exists (replay fast path)
        S-->>C: 200/422 + X-Idempotent-Replay: true (no BEGIN, no locks)
    end
    S->>DB: BEGIN
    S->>DB: SELECT … FOR UPDATE (account row)      ➊ lock #1
    S->>DB: SELECT … FOR UPDATE (user row)          ➋ lock #2
    S->>S: evaluateConsumption() — pure, zero I/O
    alt rejected
        S->>DB: INSERT rejection record · COMMIT
        S-->>C: 422 {accepted:false, reason, violation, period}
    else accepted
        S->>DB: UPDATE counters += units ×2 · INSERT accepted record · COMMIT
        S-->>C: 200 {accepted:true, usage{account,user}}
    end
```

Lock ordering ➊ → ➋ (account aggregate **always before** user row) is the
load-bearing rule that makes deadlocks unreachable by construction. The full
proofs — zero-overrun by induction over the lock funnel, deadlock-freedom via
total lock ordering, and the exactly-once replay mechanics — are in
[`docs/CONCURRENCY_AND_LOCKING.md`](docs/CONCURRENCY_AND_LOCKING.md).

---

## The four invariants

| Invariant | Mechanism | Proven by |
|---|---|---|
| **No quota overruns** under any parallelism | `SELECT … FOR UPDATE` on the account row held for the whole decision; pure evaluator checks all 4 rules before any write | Induction proof + 500-into-50 storm lands exactly 100/100 |
| **No deadlocks** | Deterministic lock order (account → user); the wait-for graph is acyclic by construction | Zero 5xx across 240-request mixed-user storms |
| **Exactly-once (idempotency)** | `UNIQUE (account_id, request_id)`; racing losers abort on SQLSTATE 23505 with increments rolled back; replays served by the fast path; fingerprint mismatch on replay is a 409 | 500 callers, one key → 1 record, 5 units, 500 identical payloads |
| **Atomic all-or-nothing decisions** | One transaction per decision: counters + audit row commit together or not at all | Crash-failure behavior table in the concurrency doc |

**Monotonic counters, not balances.** `units_consumed` only ever increases
within a UTC month; `remaining = GREATEST(0, allowance − consumed)` is
derived, never stored. Downgrade below current usage ⇒ remaining is 0 until
next month, history untouched. Upgrade ⇒ capacity returns instantly. Month
rollover is implicit (fresh `YYYY-MM` row on first touch) — no reset job to
race against.

---

## Security & correctness model

Every request path follows the same six disciplines. Each subsection names
the mechanism, where it lives, and how it is verified.

### Tenant isolation

- Every SQL query filters on the authenticated `account_id` — never a
  client-supplied value. Users resolve through `UNIQUE (account_id,
  external_id)`; plan mutations match
  `account_id = $caller AND is_predefined = FALSE`, so predefined catalog
  plans and other tenants' plans return the same 404 as nonexistent
  resources — enumeration is useless.
- API keys are 256-bit random secrets stored **only** as SHA-256 digests.
  The lookup is a single indexed comparison of a fixed-length, unprefixed
  digest; comparison timing reveals nothing beyond the authentication
  result itself.
- Auth is header-based (`X-API-Key` / `Bearer`), never cookies, so CSRF is
  structurally impossible; the dashboard is served same-origin. In
  production, cross-origin browser access requires an explicit
  `CORS_ORIGIN` allow-list.
- Verified by the IDOR attack suite (`tests/integration/api.test.ts`,
  `plans-crud.test.ts`): cross-tenant consume, usage lookups, plan
  binding, and plan deletion all fail closed with 404 and leak nothing.

### Concurrency & double-spend prevention

`BEGIN → FOR UPDATE(account row) → FOR UPDATE(user row) → pure evaluation →
atomic increments → ledger insert → COMMIT`, with the account→user lock
order held for the whole decision. Proven by induction over the lock funnel
and by 500-into-50 storms landing on exactly 100/100 (linearizability);
deadlock-freedom follows from the total lock order (zero SQLSTATE 40P01
across every suite). The transaction re-reads the account's **current**
plan binding inside the held locks — a decision and the binding it
evaluated are atomic with respect to concurrent plan switches.

### Idempotency & replay safety

`UNIQUE (account_id, request_id)` is the single source of truth: racing
duplicates serialize on the account row lock, the loser's INSERT aborts on
SQLSTATE 23505, and its counter increments roll back completely — the
quota moves exactly once. Committed decisions are immutable, so replays
take a pre-transaction fast path (one indexed read, no locks). Every
decision stores a `request_fingerprint` (SHA-256 of the canonical
`{accountId, userId, units}`); **any replay with a mismatching fingerprint
is a 409**, so one idempotency key maps to exactly one request. Rows
written before migration 003 carry a NULL fingerprint and keep replaying.
Verified by `tests/concurrency/idempotency-race.test.ts`: a 999-unit
hijack attempt against a 2-unit decision returns 409 with zero charge,
while the same-payload retry still replays.

### Plan changes mid-month

Counters are monotonic and `remaining` is derived, so a downgrade below
current usage clamps remaining to 0 until the next UTC month without
touching history, and an upgrade restores capacity instantly. Combined with
the in-transaction binding read above, rules can change while requests are
in flight without corrupting totals. Verified by
`tests/concurrency/plan-mutation-race.test.ts` (conservation under
mid-storm plan flips) and the fast-check property streams.

### Input validation & sanitization

Strict Zod DTOs at every boundary — unknown fields are 400s, `units` must
be a positive integer ≤ 1e9, `requestId` a UUID, `period` regex-checked.
100% parameterized SQL (zero string interpolation). Validation errors never
echo raw input values. All dashboard rendering routes through a real HTML
entity map, so attacker-controlled strings (account names, userIds, plan
names, error details) render as text, never markup.

### Errors & explainability (RFC 7807)

One renderer (`problemDetailsHandler`), typed `DomainError`s carrying their
own status, stable `urn:quota-engine:errors:*` type URNs, structured
`errors[]` for 400s, and the deliberate 422-is-a-business-payload (not
problem+json) contract. Rejections explain themselves: deterministic
root-cause `violation` (source, rule, limit, requested, currentUsage,
`remainingMonthly`) plus a human `reason`. Errors never leak stacks, SQL,
or other tenants' data.

---

## Performance results

**Reproduce everything with one command** — `npm run load-test` — no Docker,
no config, no external services. Full instructions, dependencies, and
configuration knobs: [`perf/README.md`](perf/README.md). Committed
artifacts: [`perf/results/benchmark-report.md`](perf/results/benchmark-report.md)
+ machine-readable [`perf/results/metrics.json`](perf/results/metrics.json).

### Latest run — 500-way concurrency (embedded PostgreSQL 17.5, Node 24)

| Benchmark | Result | Invariants (SQL-verified) |
|---|---|---|
| Quota overrun storm — 500 concurrent requests into exactly **50 remaining units** | **50 accepted / 450 rejected / 0 errors** | DB counter lands on exactly **100/100**; Σ users == account; every decision persisted |
| Idempotency replay storm — 500 concurrent callers, **one shared requestId** | **1 record / 5 units charged** | 500/500 identical payloads; 499 served as replays |
| Throughput | **189 req/s** under full-contention storm · **468 req/s** replay storm | Serialization is per-account: different tenants scale in parallel |

```mermaid
xychart-beta
    title "Latency percentiles under a 500-request storm (ms)"
    x-axis ["p50", "p95", "p99", "max"]
    y-axis "Latency (ms)" 0 --> 3000
    bar "quota storm" [1908, 2491, 2533, 2543]
    bar "replay storm" [585, 912, 1027, 1065]
```

### Interpreting the numbers

1. **The tail latency is the correctness mechanism.** Under the storm, p99 ≈
   2.5 s — but that time is *queue position*, not work: every contender for
   the same account waits its turn on the row lock, each turn costing ~3–5 ms
   of actual SQL. The convoy is what makes over-consumption mathematically
   impossible; a system with a flat p99 here would be racing its own quota
   checks.
2. **The client is part of the measurement.** Firing 500 truly simultaneous
   `fetch()` calls opens 500 TCP sockets at once; OS loopback accept-queues
   refuse bursts around ~230 with client-side `ECONNREFUSED`. The harness
   uses a bounded `undici` Agent (200 sockets, all requests logically in
   flight) — the same discipline real tools like `autocannon -c` apply — so
   the numbers measure the engine, not the TCP stack.
3. **Replays are nearly free.** Committed-decision retries take the
   pre-transaction fast path — one indexed MVCC read, no `BEGIN`, no locks —
   which is why the replay storm sustains ~2.5× the throughput of the
   write storm with a far flatter tail.
4. **JSONB does not preserve key order.** A replayed payload and a fresh
   one are semantically identical but not byte-identical; the invariant
   checks canonicalize JSON before comparing. A byte-for-byte comparison
   would report false double-spend alarms.

---

## Decisions on open questions

The requirements leave several decisions open. These are the choices this
engine makes, and the reasoning behind each:

| Open question | Decision | Rationale |
|---|---|---|
| **HTTP status for quota rejections** — 402 / 422 / 429? | **422 Unprocessable Entity** | 402 (Payment Required) is reserved for *future HTTP payment protocols* and is semantically wrong for an exhausted quota; 429 (Too Many Requests) is *rate limiting over time* — a monthly allowance is not a rate. 422 says exactly what happened: a well-formed, understood request whose semantics violate policy. A rejection is a successful *decision*, so the body is the business envelope, not `problem+json` |
| **Timezone handling** | **UTC only** — periods are `YYYY-MM` UTC calendar months | Metering must be jurisdiction-consistent; per-tenant timezones turn "monthly reset" into N different reset instants and make the audit trail ambiguous. All timestamps are `TIMESTAMPTZ`; the pg pool forces `timezone=UTC` so period math can never drift with the host clock |
| **Monthly reset mechanism** | **Implicit rollover** — no cron, no reset job | A period is part of the row key: a new month lazily creates fresh zero rows. Nothing runs, nothing races, nothing can fail open. Pinned by `tests/integration/monthly-reset.test.ts` |
| **Custom plan scoping** | **Tenant-private; custom names shadow predefined; cross-tenant binding is 404** | A plan's rules are tenant billing configuration — never global mutable state. Shadowing lets a tenant override `Basic` with its own version without touching the shared catalog |
| **Custom plan lifecycle (CRUD)** | **Full CRUD with guards**: type immutable on update; delete refused (409) while any account/user is bound | Deleting a bound plan would orphan live quota decisions against rules that no longer exist. Subjects are rebound first via `PATCH /accounts/plan` / `PATCH /users/:userId/plan` |
| **Idempotency key semantics** | **UUID required; one key ⇒ one immutable decision** (replays return the original status code) | A caller asking for a *new* decision after a plan change must use a *new* key — otherwise the engine correctly replays the old decision. Enforced by `UNIQUE (account_id, request_id)` in the database, not by convention |
| **Plan changes vs. existing usage** | **Counters are never rewritten** — `remaining = GREATEST(0, allowance − consumed)` is derived | Downgrades below current usage clamp remaining to 0 until the next month; upgrades restore capacity instantly; the audit trail stays truthful. Racing consumption against plan changes is covered by `tests/concurrency/plan-mutation-race.test.ts` |
| **What is a "unit"?** | **Opaque positive integer** (≤ 1e9 per request) | The engine meters counts, not semantics — tokens, API calls, compute-seconds are all the caller's mapping. Zod rejects 0/negative/fractional units at the transport boundary |
| **Account provisioning** | **`POST /accounts` is public** — the one bootstrap route | Chicken-and-egg: you need an account to authenticate. The key is returned exactly once; rotation is atomic |
| **Data retention** | **No delete endpoints for users/accounts/history** — append-only audit; FK cascades at the storage layer only | Billing records are legal artifacts; a delete API would be a foot-gun. Storage-level retention (partition-drop of old periods) is an ops decision, not an API one |
| **Plan-type binding** | **Hard rule: ACCOUNT plans bind accounts, USER plans bind users** | Enforced twice — service-level checks *and* database triggers, so even hand-written SQL cannot violate it |

---

## Testing

| Command | Suite | What it proves |
|---|---|---|
| `npm run test:unit` | Pure-domain tests | Every limit boundary (limit−1 / limit / limit+1 × 4 rules), downgrade semantics, deterministic precedence, programmer-error contracts, Result monad, Zod DTOs |
| `npm run test:integration` | HTTP tests | The six-phase story end-to-end, idempotent replay of accepted *and* rejected decisions, plan mutation preserving usage, RFC 7807 shapes, cross-tenant IDOR attack suite, rotation atomicity, custom-plan CRUD lifecycle, monthly reset & previous-month reads |
| `npm run test:concurrency` | Race suites | 250-into-50 quota storm, 40-way same-key race, 240-request mixed-user deadlock hunt, plan mutation racing live consumption — all asserted against SQL ground truth |
| `npm run test:property` | Property-based (fast-check) | Thousands of generated cases: evaluator vs an independently written model, acceptance/conservation/precedence invariants, randomized live-API streams with mid-stream plan flips cross-checked against an oracle |
| `npm test` | All of the above | 127 tests; every run boots a pristine embedded PostgreSQL |

CI with an external PostgreSQL: set `TEST_DATABASE_URL` and `npm test` uses
it instead of booting the embedded one. A committed GitHub Actions workflow
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs type-check,
build, and the full storm suite on every push — and can trigger the
benchmark manually (`workflow_dispatch`), uploading `perf/results/` as
artifacts.

Targeted suites for single-requirement verification (see the
[requirement verification table](#requirement-verification)):
`npm run test:idempotency` · `test:plan-change` · `test:security` ·
`test:monthly-reset` · `test:boundary`.

---

## Project structure

```
.github/workflows/ci.yml        CI: typecheck · build · full storm suite (self-contained PostgreSQL)
src/
  config/env.ts                  Zod-validated environment (fail-fast boot)
  database/
    connection.ts                pg.Pool + withTransaction (guaranteed BEGIN/COMMIT/ROLLBACK)
    migrator.ts                  checksummed, advisory-locked SQL migration engine
    migrations/                  001_initial_schema · 002_indexes · 003_request_fingerprint
  domain/                        PURE CORE — zero I/O, zero framework imports
    types.ts                     branded types · Zod DTOs · API-key crypto
    result.ts                    Result<T,E> monad
    rules.ts                     evaluateConsumption() — the entire quota policy
    errors.ts                    RFC 7807 error taxonomy
  docs/openapi.ts                hand-authored OpenAPI 3 specification
  middleware/                    auth (SHA-256) · validate (Zod) · error (problem+json)
  modules/
    accounts/ plans/ users/ metering/    routes → controller → service → repository
  client/demo.ts                 interactive six-phase simulation
  app.ts · server.ts             composition + graceful lifecycle
public/                          the web dashboard (index.html · styles.css · app.js)
perf/
  load-test.ts                   the benchmark harness
  README.md                      reproduction guide (commands · deps · knobs)
  results/                       committed results (report + metrics.json)
scripts/
  serve.ts · dev-db.ts · seed.ts
tests/
  unit/ · integration/ · concurrency/ · helpers/        (+ fast-check property suites: tests/unit/property.test.ts, tests/integration/property-stress.test.ts)
docs/
  ARCHITECTURE.md · CONCURRENCY_AND_LOCKING.md · INTERVIEW_CHEATSHEET.md · BENCHMARK_REPORT.md · PUBLISHING.md
```

Dependencies point strictly inward: the `src/domain/` core imports nothing
from modules, database, or Express; repositories accept an executor so
services own transaction boundaries.

---

## Configuration

All variables are Zod-validated at boot (invalid config = process refuses to
start). See [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development` · `test` · `production` |
| `PORT` | `3000` | HTTP port (`0` = ephemeral, used by tests/benchmarks) |
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `DB_POOL_MAX` | `20` | pg pool size — see pool rationale in the benchmark report |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Idle client eviction |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | Pool checkout timeout — fails fast instead of queueing forever |
| `CORS_ORIGIN` | *(reflect in non-production)* | Comma-separated allow-list; required for cross-origin browser access in production |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` · `silent` |

---

## Design decisions & trade-offs

The full Q&A — Redis-vs-Postgres locking, the BCNF proof, monotonic
counters, status-code semantics, append-only ledger vs mutable counter, and
the mapping to a canonical transaction skeleton — lives in
[`docs/INTERVIEW_CHEATSHEET.md`](docs/INTERVIEW_CHEATSHEET.md). Highlights:

- **Postgres row locks over Redis distributed locks** — the lock lives in the
  same ACID system as the data it guards; no fencing tokens, no split-brain,
  no second failure domain. (Redis stays the right tool for *rate limiting* —
  a different problem.)
- **Pessimistic over optimistic concurrency** — retry storms at the exact hot
  spot would livelock; row-lock queues are scheduled, bounded, and correct.
- **Append-only ledger + materialized snapshot** — `consumption_records` is
  the immutable ledger (one row per request, accepted and rejected, with the
  frozen response payload); `monthly_usage` is the O(1) balance anchor
  maintained atomically in the same transaction. Point-in-time
  reconstruction is always provable: Σ accepted-record units equals the
  snapshot counter.
- **BCNF schema** with justified, documented choices (JSONB payload
  duplication for byte-faithful replay; constraint-backed indexes never
  duplicated — see `002_indexes.sql`).
- **SHA-256 (not bcrypt) for API keys** — 256-bit random secrets make offline
  brute-force computationally impossible regardless of hash speed; slow KDFs
  are for low-entropy human passwords.

---

## Production deployment

```bash
docker compose up --build
# That's it. The API container:
#   1. waits for Postgres to pass its healthcheck
#   2. applies checksummed migrations (advisory-lock-safe)
#   3. seeds the predefined plan catalog (idempotent upsert)
#   4. starts serving the API + dashboard on http://localhost:3000
```

Or against any managed PostgreSQL:

```bash
cp .env.example .env             # set DATABASE_URL
npm run build && npm start       # compiled output in dist/
```

The Dockerfile ships a hardened runtime: multi-stage build (compilers never
ship), non-root user, `init: true` for proper SIGTERM, a `HEALTHCHECK`
hitting `/health`, and an entrypoint that migrates + seeds before serving —
multiple replicas can boot simultaneously (the migrator's advisory lock
makes that safe).

---

## Documentation map

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Visual flows, ER model, request lifecycles, indexing rationale |
| [`docs/CONCURRENCY_AND_LOCKING.md`](docs/CONCURRENCY_AND_LOCKING.md) | The zero-overrun and deadlock-freedom proofs; replay fast path |
| [`docs/BENCHMARK_REPORT.md`](docs/BENCHMARK_REPORT.md) | Measured p50/p95/p99, storm arithmetic, pool sizing (canonical copy in `perf/results/`) |
| [`docs/INTERVIEW_CHEATSHEET.md`](docs/INTERVIEW_CHEATSHEET.md) | Concept-to-implementation map + design Q&A |
| [`docs/PUBLISHING.md`](docs/PUBLISHING.md) | Creating the GitHub repository and pushing |
| [`perf/README.md`](perf/README.md) | Performance reproduction: commands, dependencies, configuration |

---

## License

MIT — see the license field in [`package.json`](package.json).
