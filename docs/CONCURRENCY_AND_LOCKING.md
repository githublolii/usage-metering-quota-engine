# Concurrency & Locking — Proof of Correctness

> This document proves, from first principles, that the consume endpoint is
> **free of quota overruns** (no double-spending) and **free of deadlocks**
> under arbitrary parallel load — and shows where those guarantees are
> measured empirically in [`BENCHMARK_REPORT.md`](./BENCHMARK_REPORT.md).

---

## 1. The threat model

Metering decisions are the textbook hard concurrency problem:

1. **Read-modify-write races.** The decision needs `current_consumed` for
   the account and user; the write updates both. Two naive concurrent
   transactions can both read `remaining = 50`, both decide "10 units OK",
   and both write — 60 units consumed against a 100-unit allowance.
2. **Retry duplication.** Networks are at-least-once. The same logical
   request can arrive twice, possibly *simultaneously*.
3. **Deadlocks.** Two tables rows are involved per decision; lock them in
   different orders in different transactions and PostgreSQL aborts one
   with SQLSTATE `40P01` (deadlock_detected) — under load, a stream of 500s.
4. **Crash partiality.** A process dying mid-decision must not leave a
   counter incremented without its audit record (or vice versa).

The engine defeats all four with a single mechanism: **one serializable
transaction per decision with deterministically ordered pessimistic row
locks**.

---

## 2. The transaction, annotated

```sql
BEGIN;                                       -- withTransaction()
                                            -- ① idempotency probe
SELECT accepted, response_payload
  FROM consumption_records
 WHERE account_id = $1 AND request_id = $2; -- plain MVCC read, no locks

SELECT * FROM users                          -- ② tenant-scoped resolution
 WHERE account_id = $1 AND external_id = $3;-- plain MVCC read, no locks
                                            -- ③ ensure account row exists
INSERT INTO monthly_usage (account_id, user_id, period, units_consumed)
VALUES ($1, NULL, $2, 0)
ON CONFLICT ON CONSTRAINT unique_usage_period DO NOTHING;

SELECT units_consumed FROM monthly_usage     -- ④ LOCK #1: account row
 WHERE account_id = $1 AND user_id IS NULL AND period = $2
 FOR UPDATE;

INSERT INTO monthly_usage (account_id, user_id, period, units_consumed)
VALUES ($1, $3, $2, 0)
ON CONFLICT ON CONSTRAINT unique_usage_period DO NOTHING;

SELECT units_consumed FROM monthly_usage     -- ⑤ LOCK #2: user row
 WHERE account_id = $1 AND user_id = $3 AND period = $2
 FOR UPDATE;

SELECT … FROM plans WHERE id IN ($account_plan, $user_plan);  -- no locks
-- ⑥ pure evaluateConsumption() decides ACCEPT or REJECT
-- ⑦a ACCEPT:
UPDATE monthly_usage SET units_consumed = units_consumed + $units
 WHERE account_id = $1 AND user_id IS NOT DISTINCT FROM NULL …;
UPDATE monthly_usage SET units_consumed = units_consumed + $units …;
-- ⑦b (both branches) persist decision + payload:
INSERT INTO consumption_records (…, request_id, response_payload, …)
 VALUES (…);
COMMIT;                                     -- ⑧ all-or-nothing
```

### 2.1 Replay fast path — ⓪ before `BEGIN`

A retry for an **already-committed** `(account_id, request_id)` never opens
a transaction at all:

```sql
-- ⓪ outside any transaction (plain MVCC read, no locks):
SELECT accepted, response_payload
  FROM consumption_records
 WHERE account_id = $1 AND request_id = $2;
-- row present → return the frozen payload + X-Idempotent-Replay: true
```

Why this is safe (and not a TOCTOU hole): a committed decision is
**immutable** — no code path ever updates `consumption_records` after its
commit — so a snapshot read can never observe a half-decided request. The
race it cannot see (two workers probing simultaneously before either
commits) is closed by the in-transaction re-check plus the unique
constraint: the loser aborts on SQLSTATE 23505 with its increments rolled
back. The performance consequence: replay storms of already-decided
requests contend with **nothing** — they skip `BEGIN`, skip the row locks,
and never join the convoy.

---

## 3. Proof 1 — zero quota overruns

**Claim.** For any account and period, after any finite set of consume
transactions (any interleaving), `units_consumed ≤ monthly_allowance` for
both the account aggregate and every user, and the sum of all users'
counters equals the account counter.

**Lemma (per-account serialization).** Step ④ takes an exclusive row lock
(`FOR UPDATE`) on `(account_id, NULL, period)` and holds it until `COMMIT`.
Exclusive row locks are held to transaction end, therefore **at most one
consume transaction for a given (account, period) is ever between steps ④
and ⑧**; every other same-account transaction is blocked at ④ in FIFO
queue order. (This is the *lock convoy* visible as the benchmark's tail
latency — throughput of a single hot account is deliberately bounded by
this funnel.)

**Induction.** Order the transactions for a given (account, period) by the
moment they acquire the account row lock: $T_1, T_2, …, T_n$. Define the
invariant $I_k$: after $T_k$ commits,
- $A_k = \sum_{i \le k, \text{accepted}} u_i \le \text{accountAllowance}$, and
- $U_k(j) \le \text{userAllowance}(j)$ for every user $j$.

$T_{k+1}$ reads, under the row locks it already holds, exactly the state
$A_k, U_k(j)$ — the lock guarantees no other transaction can interleave a
write between its read (④⑤) and its own writes (⑦). `evaluateConsumption`
accepts only if $A_k + u \le \text{allowance}$ and $U_k(j) + u \le
\text{userAllowance}(j)$ (plus per-request maxima). Hence $I_{k+1}$ holds.
Base case $k=0$ holds ($A_0 = 0 \le$ allowance; allowances are `CHECK (>=
0)`).

Therefore the final state satisfies the quota bounds, **regardless of how
many transactions run concurrently** — a serial executor would produce the
same final counter. (Linearizability: the lock funnel *is* the
serialization point.)

**Corollary (the storm arithmetic).** 50 units remaining, 500 concurrent
1-unit requests ⇒ exactly 50 transactions find `remaining ≥ 1` and accept;
every subsequent transaction sees `remaining == 0` and rejects with
`account/monthly_allowance`. Measured: `50 accepted / 450 rejected`,
database counter lands on exactly `100/100` —
[Benchmark 1](./BENCHMARK_REPORT.md).

**All-or-nothing dual-quota.** The pure evaluator checks four rules
(user/account × per-request/monthly) *before* any write; a single failure
consumes zero units. There is no code path that increments one counter
without the other, because both increments and the audit insert commit
atomically in step ⑧.

---

## 4. Proof 2 — deadlocks are mathematically eliminated

### 4.1 Coffman condition under test

Deadlock requires all four Coffman conditions; the one engineers can
*deterministically* remove is **circular wait**:

> A set of transactions $T_1 … T_n$ is deadlocked iff each $T_i$ waits for
> a resource held by $T_{i+1 \bmod n}$. Circular wait requires that there
> is **no total order on resources consistent with every transaction's
> acquisition sequence**.

### 4.2 The total order

Define the resource order for each consume transaction:

$$R_1 = \text{row } (account\_id, \text{NULL}, period) \;<\; R_2 = \text{row } (account\_id, user\_id, period)$$

Every consume transaction acquires **R1 before R2** — the account lock (④)
always precedes the user lock (⑤). Both the ensure-upserts and the
`FOR UPDATE` selects follow the same order in
`metering.repository.ts`, and no other statement in the transaction touches
`monthly_usage`.

What about the other locks the transaction takes?

| Lock/resource | Acquired | Can it participate in a cycle? |
|---|---|---|
| `consumption_records` unique-index token for `(account_id, request_id)` | step ⑦, after R1+R2 | See §4.3 — an aborting 23505, not a held lock; and same-key racers are serialized behind R1 first |
| `monthly_usage` unique-index speculative tokens (upserts) | transiently, inside steps ③/⑤ | Released as soon as the conflict resolves; waiters at step ③ hold *no* row locks yet; waiters at step ⑤ already hold R1, while the conflicting inserter is strictly ahead (it holds R1 exclusively — otherwise the waiter wouldn't have R1) |
| Row locks on `plans` rows | none — plain MVCC reads | no locks, no participation |

### 4.3 The subtle case: two racers, same `request_id`

$T_A$ and $T_B$ carry the same `(account_id, request_id)$:

1. Both pass the ① probe (nothing committed yet — this is exactly the
   at-least-once delivery scenario).
2. Both need R1. Exactly one wins (say $T_A$); $T_B$ **blocks at ④ holding
   nothing**.
3. $T_A$ inserts its record (⑦), commits, releases R1/R2.
4. $T_B$ acquires R1, R2, evaluates, inserts → the unique index raises
   **SQLSTATE 23505** (`unique_violation`) because $T_A$'s row is now
   committed. The INSERT failure aborts $T_B$'s **entire** transaction —
   PostgreSQL rolls back *everything*, including its counter increments.
5. The service catches `23505` on `unique_request_idempotency`, re-reads
   the stored record, and returns $T_A$'s frozen payload with
   `X-Idempotent-Replay: true`.

At no point does a transaction wait on a resource held by a transaction
that is itself waiting on the first — the wait-for graph is a forest of
stars whose centers are R1 rows, never a cycle. **SQLSTATE 40P01 is
unreachable by construction.** The mixed-user storm (3 users × 80
requests, `tests/concurrency/lock-ordering.test.ts`) asserts zero 5xx —
a single deadlock would surface as an unexpected 500.

### 4.4 Why `ON CONFLICT … DO NOTHING` cannot resurrect the problem

A plain `INSERT` that conflicts on a unique index blocks on the
conflicting transaction's speculative token (it waits to learn whether the
inserter commits or aborts). Two concerns:

- **Ordering:** the ensure-upserts run in the same R1 → R2 order as the
  lock selects, so token waits obey the same total order.
- **Progress:** can the token wait block the *holder* from finishing?
  The only transactions that can conflict on the account-row token are
  same-account transactions, and they are all serialized *before* reaching
  it (whoever holds/waits on R1 ownership is strictly ahead of whoever is
  still queued). Conflicting user-row tokens (same user) likewise sit
  strictly behind the current R1 holder in the funnel. The holder never
  waits on a token the waiter owns — waiters own nothing the funnel
  leader needs. Hence no cycle, and no livelock: the token wait resolves
  at the leader's commit/abort, guaranteed by PostgreSQL's two-phase
  commit semantics.

---

## 5. Why not the alternatives? (design-defense summary)

| Alternative | Failure mode we refuse to ship |
|---|---|
| **Redis distributed lock** (`SET key NX PX`, or Redlock) | Fencing-token problem (Kleppmann): after a GC pause or network partition, two clients can both believe they hold the lock — Redis does not participate in the database's transaction. The quota update and the audit insert would no longer share one ACID commit; a crash between `INCR` and `INSERT` bills a customer with no decision record. Also: split-brain during Redis failover can *lose* locks entirely. PostgreSQL row locks live in the same process as the data — a lock holder is by construction the transaction updating the data. |
| **Optimistic / compare-and-swap** (`UPDATE … WHERE units_consumed = $old`) | Correct but livelock-prone at the exact hot spot: 500 contenders, 450 retries each — retry storms, unbounded tail latency, and wasted audit writes. Pessimistic waiting is *scheduled* (FIFO at the row); optimistic retrying is not. |
| **Counter in the application / in-memory** | Multi-instance deployments diverge silently; a restart loses the month's history; impossible to audit. |
| **Redis token bucket / limiter libraries** | Rate limiting (requests per second) is a *different problem* from metering (units per billing month) — see cheatsheet Q6. Buckets lose the audit trail and the transactional link to the plan catalog. |

---

## 6. Pool sizing & convoy math

- Throughput of one hot account is bounded by the funnel:
  $T_{\text{account}} \approx n_{\text{requests}} \times t_{\text{tx}}$ where
  $t_{\text{tx}} \approx 3\text{–}5\,\mathrm{ms}$ for the 9-statement
  transaction on local PostgreSQL. The benchmark measured 500 requests →
  ~2.2 s wall, p50 ≈ 1.5 s — that p50 *is* the queue position of the
  median contender, not per-transaction cost.
- `DB_POOL_MAX` beyond a small multiple of the account fan-out does not
  raise single-account throughput (the convoy is the bottleneck); it only
  deepens queues and burns PostgreSQL `max_connections` (default 100).
  20 (production default) leaves headroom for migrations, the demo client,
  and observability. *Different* accounts serialize independently and in
  parallel — aggregate throughput scales with tenant count.
- Pool waits are bounded by `DB_CONNECTION_TIMEOUT_MS` (5 s default): a
  request that cannot even reach the convoy fails fast with a 500
  problem+json instead of hanging forever.

---

## 7. Failure-injection behavior (what the logs prove)

| Failure | Observable behavior | Guarantee |
|---|---|---|
| Process killed mid-transaction | PostgreSQL logs `unexpected EOF on client connection with an open transaction`; rolls the transaction back | No partial commit: counters and audit move together or not at all |
| Same `requestId` delivered twice, in parallel | Losers log `duplicate key value violates unique constraint "unique_request_idempotency"` at ⑦, then abort | Exactly one record, one charge; both callers get the identical decision payload |
| Same `requestId` delivered twice, sequentially | ⓪ fast path: single MVCC read, no `BEGIN`, no locks, no convoy | Retry latency ≈ one indexed SELECT; zero contention with live decisions |
| 500-way storm on 50 remaining units | 50 × 200s, 450 × 422 with `account/monthly_allowance` | Counter lands exactly on 100/100 (see report) |
| Kill the database between increments | Transaction cannot commit; all four statements revert | Usage can never exceed allowance |
| `pool.connect()` timeout | `withTransaction` rejects before `BEGIN` | Request dies before touching any state |

---

## 8. Implementation notes

Three details that are easy to get wrong:

1. **JSONB does not preserve key order.** A freshly-built accepted payload
   and its replayed twin (parsed back from `response_payload JSONB`) are
   *semantically identical* but not byte-identical. The replay-storm
   invariant therefore compares canonicalized JSON — a byte-for-byte
   comparison would report false mismatches.
2. **The load generator is part of the measurement.** Firing 500 truly
   simultaneous `fetch()` calls opens 500 TCP sockets at once; OS accept
   queues on loopback start refusing connections at ~250 (client-side
   `ECONNREFUSED`, no server log). The benchmark and test harness use a
   bounded `undici` Agent (200 sockets, all requests logically in flight)
   — the same discipline real load tools (`autocannon -c`) apply. Prove
   the client is not the bottleneck before drawing conclusions about the
   server.
3. **Postgres session timezone.** The pool forces `options: '-c timezone=UTC'`
   so `NOW()`-based period math can never drift with the host clock
   (`NOW() AT TIME ZONE 'UTC'` returns a *naive* timestamp — a subtle bug
   on non-UTC hosts; see `001_initial_schema.sql`).
