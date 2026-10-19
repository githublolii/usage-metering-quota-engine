# Performance & Concurrency — Reproduction Guide

> Everything needed to reproduce the benchmark numbers in this repository:
> the commands, the dependencies, the configuration knobs, and the committed
> results from the last run. No Docker, no external services — the only
> prerequisite is `npm install`.

---

## TL;DR — reproduce in one command

```bash
npm install
npm run load-test
```

That is the entire setup. With no `DATABASE_URL` configured, the harness
boots a **throwaway embedded PostgreSQL 17** (migrated + seeded automatically),
runs both adversarial benchmarks against a live HTTP server, verifies every
invariant against **SQL ground truth**, and rewrites the committed results:

| File | Contents |
|---|---|
| [`results/benchmark-report.md`](./results/benchmark-report.md) | Canonical human-readable report (environment, tables, latency percentiles, analysis) |
| [`results/metrics.json`](./results/metrics.json) | Machine-readable numbers: latencies, throughput, DB counters, and every invariant with pass/fail |
| [`../docs/BENCHMARK_REPORT.md`](../docs/BENCHMARK_REPORT.md) | Mirror kept with the documentation suite |

---

## What the benchmarks prove

### Benchmark 1 — Quota Overrun Storm ("500 into 50")

A fresh Starter account (100 units/month) is pre-drained to exactly **50
remaining units**. Then **500 concurrent requests** each try to consume
1 unit (unique idempotency keys). The invariants, all asserted by querying
PostgreSQL directly:

- exactly **50 accepted**, **450 rejected** — zero over-consumption;
- account counter lands on exactly **100/100** (the same total a serial
  executor would produce — linearizability);
- user counters sum to the account counter — zero lost updates;
- every decision (accepted AND rejected) persisted exactly once in the audit
  trail.

This exercises the full transaction path: `BEGIN` → `FOR UPDATE` on the
account row → `FOR UPDATE` on the user row → pure evaluation → atomic
increments → ledger insert → `COMMIT`, under maximal contention on one
account.

### Benchmark 2 — Idempotency Replay Storm ("one key, 500 callers")

**500 concurrent requests share one `requestId`.** The invariants:

- exactly **ONE consumption record** in the database;
- units charged **exactly once** (5 total);
- all 500 callers receive the **identical decision payload**;
- 499 of them are served as replays (`X-Idempotent-Replay: true`).

This exercises both idempotency layers: the **replay fast path** (a
committed decision is returned by a plain MVCC read — no `BEGIN`, no locks,
no convoy) and the **race path** (simultaneous duplicates serialize on the
account row lock; the losers' `INSERT` aborts on
`UNIQUE (account_id, request_id)` with SQLSTATE 23505, rolling back their
counter increments entirely).

---

## Commands

| Command | What it runs |
|---|---|
| `npm run load-test` | Both benchmarks, 500 concurrent requests each, embedded PostgreSQL, regenerates `results/` + docs mirror |
| `LOAD_TEST_REQUESTS=2000 npm run load-test` | Scale the storm size |
| `LOAD_TEST_CONNECTIONS=100 npm run load-test` | Client socket ceiling for the load generator (see "transport" below) |
| `DATABASE_URL=postgres://… npm run load-test` | Target an external PostgreSQL instead of the embedded one |
| `npm run test:concurrency` | The vitest race-condition suites that assert the same invariants in CI (quota storm, idempotency race, mixed-user lock-ordering/deadlock hunt) |
| `npm test` | Full suite: unit (pure domain) + integration (HTTP) + concurrency |

Windows PowerShell note: set env vars inline with
`$env:LOAD_TEST_REQUESTS='2000'; npm run load-test`.

## Dependencies

- **Node.js ≥ 20.11** (developed on 24.x) and npm — nothing else to install
  globally. All tooling comes from `package.json`:
  - Runtime: `express`, `pg`, `zod`, `picocolors`
  - Benchmark transport: `undici` (bounded connection pool for the load
    generator — see below)
  - Dev-time runners: `tsx` (TypeScript execution), `vitest` (CI suites)
  - Zero-config database: `embedded-postgres` (devDependency; ships real
    PostgreSQL 17 binaries — no Docker, no admin rights)
- **PostgreSQL 16+** — provided by `embedded-postgres` by default, or bring
  your own via `DATABASE_URL` (16/17 both verified).

## Configuration knobs

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | *(unset → embedded PostgreSQL)* | Target database (must be migrated + seeded; the embedded path does both for you) |
| `LOAD_TEST_REQUESTS` | `500` | Concurrent requests per benchmark |
| `LOAD_TEST_CONNECTIONS` | `200` | Client socket ceiling (undici Agent) |
| `DB_POOL_MAX` | `50` (benchmark default) | Server-side pg pool size — see the report's pool-sizing rationale |

## Methodology notes (what makes these numbers honest)

1. **Live HTTP, not an in-memory harness.** The benchmarks drive a real
   Express server (`app.listen(0)`) over loopback: JSON parsing, routing,
   Zod validation, and connection pooling are all in the measured path.
2. **Ground truth is the database.** Accepted/rejected counts are never
   trusted from HTTP alone — every invariant is re-verified with SQL queries
   after the storm settles.
3. **The client is bounded on purpose.** Firing 500 truly simultaneous
   `fetch()` calls opens 500 TCP sockets at once; OS accept queues on
   loopback refuse bursts around ~230 with client-side `ECONNREFUSED`. The
   generator uses a bounded undici Agent (default 200 sockets) so all
   requests are logically in flight while the *server*, not the TCP stack,
   is the thing under test. Real load tools (`autocannon -c`) apply the
   same discipline.
4. **JSONB key order is normalized.** Replay-payload equality is checked
   with canonical JSON (sorted keys) because PostgreSQL JSONB does not
   preserve key order — a byte-comparison would report false mismatches.

## Committed results & regenerating them

`results/` holds the outputs of the last run on the development machine
(Node 24 / Windows / embedded PostgreSQL 17.5). They are committed on
purpose: results and the tools that produce them belong together.
Re-running `npm run load-test` overwrites both files with fresh,
locally-truthful numbers for your hardware.

The CI regression equivalents of these invariants live in
[`tests/concurrency/`](../tests/concurrency/) and run as part of `npm test`.
