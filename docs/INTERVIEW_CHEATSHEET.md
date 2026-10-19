# Interview Cheatsheet — Syllabus Term Map & Defense Answers

> Direct map from the Boot.dev syllabus (see `lessons_&_concepts_taken.txt`)
> to the concrete lines of code that implement each concept, followed by
> the senior-level defense answers for the questions examiners actually ask.
>
> Commandments for this repo: every claim below is verifiable — the file
> paths point at the implementation, the tests point at the guarantee.

---

## Part 1 — Syllabus term map

| Syllabus term | Where it lives in this repo | The one-line defense |
|---|---|---|
| Authentication vs. Authorization | `src/middleware/auth.middleware.ts` (who are you — API key → account) vs. plan rules in `src/domain/rules.ts` (what you may do — quota policy) | AuthN resolves identity; authZ is enforced *by the pure quota evaluator*, not by decorators |
| Password Security Best Practices | `hashApiKey` in `src/domain/types.ts` — SHA-256 digest of a 256-bit random key; plaintext never stored (migration 001, `api_key_hash VARCHAR(64) UNIQUE`) | High-entropy random keys don't need bcrypt's slow KDF (see Q10) |
| Types of Authentication | `extractApiKey` — `X-API-Key` header or `Authorization: Bearer` | Both parsed in one function; tests cover both paths |
| Custom Errors in TypeScript / Error-Handling Middleware | `src/domain/errors.ts` (`DomainError` hierarchy carrying HTTP status) + `problemDetailsHandler` in `src/middleware/error.middleware.ts` | The domain owns status-code semantics; exactly one renderer, never leaks stacks |
| SQL Injection | 100% parameterized queries: `$1, $2…` everywhere (`*.repository.ts`); zero string interpolation into SQL | The one place string concatenation would be tempting — ORDER BY — is fixed enums, not user input |
| Multi-Column Indexes | migration `002_indexes.sql` — e.g. `(account_id, period, created_at DESC)` | Column order = equality columns first, range/sort last |
| SQL Indexes / Denormalizing for Speed | ARCHITECTURE §7 — index table + the *deliberate omission* of duplicate constraint-backed indexes | Every index must earn its write-amplification cost; UNIQUE constraints already provide one |
| Normal Forms (1NF→BCNF) | migration `001_initial_schema.sql`; proof below in Q3 | Every determinant is a candidate key ⇒ BCNF |
| Table Relationships / FKs / Constraints | 001: FKs with `ON DELETE CASCADE`, CHECKs, UNIQUEs, plus triggers for cross-table CHECK impossibilities | Constraints live in the database, not only in app code |
| Database Migrations / Altering Tables | `src/database/migrator.ts` — checksummed, advisory-locked, transactional | Editing an applied migration is a hard error |
| Database Schema / Data Types | `TIMESTAMPTZ` + `NOT NULL` + defaults; `period VARCHAR(7)` with a regex CHECK | UTC everywhere; the pool forces `timezone=UTC` |
| Joins | `accounts.repository.ts` `findAccountWithPlan` (accounts⨝plans), `metering.repository.ts` `listHistory` (records⨝users) | Joins on PK/FK only, always tenant-scoped |
| Aggregations (SUM/COUNT/GROUP BY) | `countHistory` (`COUNT(*)`), `recordCounts` (`GROUP BY accepted`) | `COUNT(*)::text` because pg returns bigint as string |
| Subqueries / OR / IN / BETWEEN | History filter uses parameterized nullable predicates (`($2::uuid IS NULL OR user_id = $2)`) — index-friendly, one plan for all filter shapes | One prepared-statement shape beats N dynamic SQL branches |
| Runtime Validation with Zod | `src/domain/types.ts` schemas + `src/middleware/validate.middleware.ts` | `.strict()` — unknown fields are 400s, never silently ignored |
| JSON / JSON.stringify / Parsing | `response_payload JSONB` stores the frozen decision; `canonicalJson` in load-test for comparisons | JSONB normalizes away key order — a classic replay-comparison gotcha |
| HTTP Status Codes / PATCH vs PUT / Methods | Q5 below + `accounts.routes.ts` (PATCH /plan is a partial update of the binding) | 200 vs 201 vs 400 vs 401 vs 404 vs 409 vs 422 vs 500 all have assigned owners |
| HTTP Headers / Cookies / Webhooks | API keys via headers only; no cookies (stateless service-to-service auth); no webhook surface in scope | Headers over cookies for non-browser clients |
| Middleware in Express / Routing / Req-Res objects | `src/app.ts` composes helmet → cors → json → per-router auth → validate → controller | One error renderer at the end of the chain |
| Async TypeScript / Single-Threaded Servers | `withTransaction` in `src/database/connection.ts` — async/await with guaranteed BEGIN/COMMIT/ROLLBACK/release in `finally` | Node interleaves handlers; the *database* provides atomicity |
| Disciminated Unions / Type Narrowing / Branded types | `ConsumeResponseBody` union, `Result<T,E>`, branded `AccountId`/`UserId`/`Period` in `src/domain/types.ts` | `remaining` can't be negative; `UserId` can't be confused with `ExternalUserId` |
| Generics / Utility Types / Mapped types | `Result<T,E>` monad in `src/domain/result.ts`; `Brand<T,B>` | A 40-line Result monad beats an exceptions-as-control-flow API |
| Referential Transparency / Pure Functions (FP course) | `src/domain/rules.ts` — zero I/O, zero framework imports, 60 unit tests over boundaries | The entire business policy is a pure function; provable by unit test |
| Sum Types | `Result` + `ConsumptionEvaluation` + `ConsumeResponseBody` | Rejection is a *value*, not an exception — the type forces handling |
| SQL CRUD / DELETE danger | No DELETE endpoints at all; deletes only via FK cascades | Audit rows are append-only |
| Memory vs Disk / Setting up PostgreSQL | `scripts/dev-db.ts` boots real PostgreSQL binaries locally (no Docker needed) | "In-memory" databases would validate nothing about locking |
| Docker (full course) | `Dockerfile` (multi-stage, non-root, HEALTHCHECK), `docker-compose.yml` (healthcheck-gated `depends_on`), `.dockerignore` | Multi-stage build = compilers never ship; `init: true` = proper SIGTERM propagation |
| Load Balancers / Networks | Stateless API tier (§1 of ARCHITECTURE) — any LB works; all coordination is in Postgres | Scaling out requires no session affinity |
| Monitoring / Resource Limits / Logs | `GET /health` (process + DB), structured console logging with levels, `LOG_LEVEL` env | Health check proves DB reachability, not just process liveness |
| Config files / CLI commands | `src/config/env.ts` — Zod-validated env, fail-fast on boot | The process refuses to start with invalid config |

---

## Part 2 — Defense answers (the questions examiners ask)

### Q1. Why PostgreSQL pessimistic locks (`FOR UPDATE`) instead of Redis distributed locks?

**The three-part answer:**

1. **ACID coupling.** A quota decision is not "hold a lock" — it is "hold a
   lock, read two counters, evaluate policy, write two counters, insert an
   audit row, all-or-nothing." A Postgres row lock is held *by the
   transaction that performs exactly those writes*. With Redis, the lock
   and the data live in different systems: the process can acquire the
   Redis lock, then crash before the DB commit (lock lost, decision
   lost), or crash *after* the DB commit but before unlocking (lock
   orphaned until TTL — during which every retry is blocked or, worse,
   the TTL expires and a duplicate proceeds).

2. **Fencing tokens / split-brain.** Redis async replication means a
   failover can *lose* the lock entirely: client A holds the lock on the
   primary, the primary dies before replicating, the replica promotes,
   client B acquires the "same" lock — two writers, double spend. Redlock
   debates (Kleppmann vs. antirez) exist precisely because there is no
   clean fix without fencing tokens — and a fencing token is only useful
   if the *storage system validates it*, which is exactly what a
   Postgres row lock already does implicitly. When your source of truth
   is a single ACID database, the database's own lock manager is the
   simplest correct option.

3. **Failure modes.** Redis unreachable = engine down (or worse,
   fail-open). Postgres unreachable = engine down anyway, because we
   cannot record the decision. Adding Redis adds a second failure domain
   with *no* benefit, since we already require Postgres for every
   decision.

**Concession to make (interviewers love this):** Redis *is* the right
tool for **rate limiting** (requests/second, approximate, lossy-tolerant)
and for read-heavy caching of the plan catalog. It is the wrong tool for
**billing-grade metering**, where every unit must be accounted exactly
once.

### Q2. How are deadlocks mathematically eliminated?

Full proof in [`CONCURRENCY_AND_LOCKING.md`](./CONCURRENCY_AND_LOCKING.md)
§4. The spoken version: "Deadlock needs circular wait. Our transactions
touch exactly two lockable rows — the account aggregate and the user row —
and always acquire them in the same total order (account first). With a
total order consistent with every transaction's acquisition sequence,
cycles in the wait-for graph are impossible, hence SQLSTATE 40P01 is
unreachable by construction, not by tuning (`deadlock_timeout`,
retries-on-40P01, etc.). The mixed-user storm test asserts zero 5xx — a
single deadlock would appear as an unexpected 500."

Mention the subtle same-requestId case: the loser's `INSERT` takes a
unique-violation (23505), aborts its own transaction (rolling back its
increments), and the service replays the winner's stored payload — an
abort, not a deadlock.

### Q3. Prove BCNF (and 3NF) compliance.

Definitions: for relation $R$, a determinant $X \to Y$ violates **BCNF**
iff $X$ is not a superkey. 3NF allows the exception where $Y$ is prime;
BCNF does not.

- **accounts**: `id → (name, api_key_hash, plan_id)`; `api_key_hash → id`
  (UNIQUE). Both determinants are candidate keys (id, api_key_hash).
- **plans**: `id → all`; `(account_id, name, type) → id` (UNIQUE NULLS
  NOT DISTINCT). Both candidate keys. Single-valued facts only.
- **users**: `id → all`; `(account_id, external_id) → id`. Both keys.
- **monthly_usage**: `id → all`; `(account_id, user_id, period) →
  units_consumed, updated_at`. Both keys. The aggregate row (user_id
  NULL) is a *fact about the account*, not redundancy: it is the locked
  serialization point and cannot be derived from user rows without a
  race.
- **consumption_records**: `id → all`; `(account_id, request_id) → all`.
  `rejection_*` columns are functionally dependent on `id` (one decision
  per row), guarded by the `rejection_shape` CHECK so the nullable triple
  is never half-populated.

No transitive dependencies (3NF), no non-trivial determinant that isn't a
candidate key (BCNF). Justified denormalization (the one discussed
deviation): `response_payload` *duplicates* the decision fields —
deliberately, because it freezes exactly what the client received for
idempotent replay, and the two copies serve different consumers
(structured querying vs. byte-faithful replay).

### Q4. Why monotonic additive counters beat mutable balance buckets?

1. **Mid-month downgrades.** Balance 40, new allowance 30 → a stored
   balance needs a migration or a clamp hack. With counters,
   `remaining = GREATEST(0, 30 - 160) = 0` — derived, correct, and
   history untouched.
2. **Auditability.** `units_consumed` + the append-only
   `consumption_records` let you reconstruct *every* month's truth. A
   mutable balance is a single overwritten cell — "who spent what" is
   gone.
3. **Crash & concurrency safety.** Incrementing a counter inside a locked
   transaction is commutative and idempotent-safe; decrementing a shared
   balance invites negative-balance races and ABA bugs.
4. **Plan mutations are O(1) and instant.** Binding a new plan is one
   `UPDATE accounts SET plan_id`; no balance recalculation job, no
   read-repair.
Cost to acknowledge: `remaining` needs the plan row at read time (one PK
join, already loaded) and rollover is implicit (a new `YYYY-MM` row per
period — zero cron jobs).

### Q5. HTTP status codes & idempotency semantics — why 200 vs 422 vs 409?

| Code | Used for | Why exactly this one |
|---|---|---|
| `200` | accepted consume; idempotent replay of an accepted decision | The request was processed; body carries the (frozen or fresh) result |
| `201` | account / user / plan creation | A new resource now exists (`Location`-class semantics) |
| `400` | Zod validation failure, malformed JSON | The request *shape* is wrong — retrying unchanged will never succeed |
| `401` | missing/unknown API key | `WWW-Authenticate`-class; distinguishes "who are you" from "what you may do" |
| `404` | unknown user/plan **within the tenant** | Deliberately indistinguishable from nonexistent → IDOR probing is useless |
| `409` | duplicate user, duplicate plan name, wrong plan type binding | State conflict that *could* resolve on retry with different input |
| `422` | quota rejection (semantic violation of a well-formed request) + replay of a rejected decision | RFC 9110: "understandable but semantically erroneous" — exactly a quota violation |
| `500` | unexpected failures (pool timeout, bug) | Generic body; details only in server logs |

**The subtle one:** a replayed *rejection* returns 422, not 409 — the
idempotency contract is "same key ⇒ same response, byte-for-byte
semantics," including status. `409` is reserved for conflicts the client
can act on. And `PATCH /accounts/plan` (not PUT) because it changes one
field of the account resource.

### Q6. Rate limiting vs metering — aren't they the same?

No, and conflating them is a classic architecture smell. Rate limiting =
sliding window of requests/second, approximate, lossy-tolerant, usually
Redis. Metering = exact cumulative units per UTC month, auditable,
idempotent, transactional. This engine implements *metering*; a token
bucket could be layered in front without touching this design.

### Q7. Why is the evaluator pure, and why does purity matter here?

`evaluateConsumption` (src/domain/rules.ts) takes numbers in and returns a
discriminated union out — no clock, no DB, no randomness. Purity buys:
(1) exhaustive boundary testing (limit−1 / limit / limit+1 × 4 rules) in
milliseconds; (2) the transaction can call it while holding locks without
fear of I/O inside the critical section (short lock hold time = shorter
convoy); (3) formal reasoning — the same function that decides production
traffic decided every unit test. Referential transparency is the FP
course's payoff: same inputs ⇒ same decision, always.

### Q8. Where exactly do the zero-overrun and exactly-once guarantees come from?

- Zero overrun: exclusive row lock on the account aggregate held for the
  whole decision + induction over the serial order (CONCURRENCY §3).
- Exactly-once: `UNIQUE (account_id, request_id)`; racing inserts lose
  with 23505, their whole transaction aborts (increments rolled back),
  and the service replays the winner's frozen JSON payload.
- Together, they're why the 500-into-50 storm lands on exactly 100/100
  with 450 clean 422s and 1 record per shared key (BENCHMARK_REPORT).

### Q9. Walk me through the pool sizing.

Single-account throughput is bounded by the row-lock funnel, not by
connection count: p99 grows with queue depth, so `DB_POOL_MAX = 20`
(production) caps memory and stays far under Postgres `max_connections =
100` with headroom for migrations/tooling. The benchmark runs 50 to show
the convoy effect; larger pools only deepen the wait queue (measured p50
≈ queue position). `DB_CONNECTION_TIMEOUT_MS = 5000` fails fast instead
of stacking requests forever.

### Q10. Why SHA-256 for API keys instead of bcrypt/argon2?

bcrypt exists to slow *offline brute-force of low-entropy human
passwords*. Our keys are 256-bit random (`mk_<43 base64url chars>` ≈ 2²⁵⁶
space) — brute force is computationally impossible regardless of hash
speed, so the slow KDF buys nothing. SHA-256 gives: constant-time-ish
indexed lookup (`api_key_hash` UNIQUE, 64 hex chars), no plaintext
anywhere, trivial rotation (one UPDATE). Caveat to volunteer: if the
system ever stored *human-chosen* secrets, a memory-hard KDF (argon2id)
would be mandatory.

### Q11. What happens on month rollover?

Nothing runs; nothing can race. `currentUtcPeriod()` computes `YYYY-MM`
from UTC at request time; the first request of a new month lazily creates
zero rows via the ensure-upsert, and old months' rows simply stop being
touched. No cron job means no "reset job vs. in-flight request" race —
the classic bug in balance-based designs.

### Q12. Deliberate deviations from the reference DDL (know these cold)

1. `DEFAULT NOW()` instead of `NOW() AT TIME ZONE 'UTC'`: the latter
   returns a *naive* timestamp; storing it into TIMESTAMPTZ re-interprets
   it in the session zone — silent drift on non-UTC hosts. `NOW()` on a
   TIMESTAMPTZ column stores the correct instant anywhere, and the pool
   forces `timezone=UTC` for deterministic period math.
2. Dropped the duplicate `idx_usage_lookup` /
   `idx_user_external_account` indexes: UNIQUE constraints already create
   identical btree indexes; duplication doubles write amplification for
   zero read benefit (002_indexes.sql header).
3. Added plan-type binding triggers: CHECK constraints can't span tables;
   without triggers, hand-written SQL could bind a USER plan to an
   account.
4. Added `rejection_shape` CHECK: makes a half-populated rejection
   (reason without rule, etc.) impossible at the storage layer.
5. `plans`⇄`accounts` mutual FK created in staged order (plans → accounts
   → ALTER TABLE plans): the catalog must exist before the first account.

### Q13. What would you do differently at 10× scale?

Own it as a roadmap, not a confession: (1) shard hot accounts by
`account_id` (Citus-style) since serialization is per-account anyway;
(2) add a Redis-backed *rate limiter* in front (different concern, Q6);
(3) move history reads to a read replica with a `pg_logical` lag budget;
(4) partition `consumption_records` by `period` (drop-or-archive old
months); (5) consider `SELECT … FOR UPDATE SKIP LOCKED` for a background
reconciliation worker — never for the decision path, which must stay
blocking-correct.

### Q14. Map the canonical transaction skeleton to this codebase, line by line.

Graders often bring a reference skeleton (`account_usage`, `user_usage`,
`request_logs`). Here is the exact equivalence — same locking discipline,
different (unified) physical layout:

| Skeleton | This implementation | Why equivalent (or better) |
|---|---|---|
| `BEGIN` | `withTransaction()` in `src/database/connection.ts` | Guaranteed BEGIN/COMMIT/ROLLBACK pairing; client always released in `finally` |
| `SELECT … FOR UPDATE` on `account_usage` | `lockAccountUsage()` — `monthly_usage` row with `user_id IS NULL` | Same row, same exclusive lock, acquired **first** always |
| `SELECT … FOR UPDATE` on `user_usage` | `lockUserUsage()` — `monthly_usage` row with `user_id = <uuid>` | Same row, acquired **second** always — the total order that kills deadlocks |
| Evaluate in memory against active plans | `evaluateConsumption()` — pure, zero I/O | Identical shape, plus: rejection is a typed value, not an exception, and it's exhaustively unit-tested |
| `UPDATE … SET consumed_units = consumed_units + $units` ×2 | `incrementUsage()` ×2 — additive monotonic increments | Same atomic in-place increment on rows we already hold locked |
| `INSERT INTO request_logs …` | `insertConsumptionRecord()` into `consumption_records` | Audit ledger AND idempotency registry are **one table** — they can never diverge |
| `CREATE UNIQUE INDEX idx_account_request_id ON request_logs(account_id, request_id)` | `CONSTRAINT unique_request_idempotency UNIQUE (account_id, request_id)` | Same unique btree, declared as a constraint so the schema self-documents |
| “If a request comes in with an existing request_id, don’t run the transaction” | ⓪ Pre-transaction replay fast path + in-transaction re-check | Committed decisions are immutable ⇒ an MVCC read suffices; simultaneous racers still lose on 23505 with increments rolled back |
| Return prior response with `X-Idempotent-Replay: true` | Same header, original status code (200/422), frozen payload | The status code replays too — “same key ⇒ same response” |

**Spoken version:** “Yes — my transaction is exactly that skeleton. The one
structural difference: I keep account and user counters in a single
`monthly_usage` table where `user_id IS NULL` marks the account aggregate.
That preserves the lock ordering (the NULL row is always locked first),
gives me one unique constraint for both row shapes, and means usage rows
cascade-delete with the account. The idempotency ledger is `consumption_records`
with a unique `(account_id, request_id)` constraint, and replays of committed
decisions skip the transaction entirely via a read-only fast path.”

### Q15. Why can a custom plan be updated while bound, but only deleted while unbound?

**Update-while-bound is safe by design:** plans only parameterize the pure
evaluator — a decision reads the *current* limits inside the transaction it
already holds locks in. Lowering an allowance on a bound plan just clamps
`remaining` to 0 (monotonic counters, derived budget); raising it expands
capacity instantly. No migration, no recalculation job, nothing to corrupt.

**Delete-while-bound would be a referential lie:** every live decision must
resolve against rules that exist. If a bound plan vanished, users/accounts
would point at a dangling `plan_id` (FKs would block the raw SQL anyway) and
the audit trail would reference unnameable rules. So DELETE returns **409**
naming the remaining bindings, and the subjects are first rebindable through
`PATCH /accounts/plan` and `PATCH /users/:userId/plan` — the same runtime
mutation paths, which never touch usage counters.

Ownership notes worth volunteering: the UPDATE/DELETE SQL matches
`account_id = $caller AND is_predefined = FALSE`, so predefined catalog
plans and other tenants' plans return **404** — indistinguishable from
nonexistent, which is exactly the IDOR posture used everywhere else. Plan
**type is immutable** on update: an ACCOUNT plan silently becoming a USER
plan would change what every bound subject means; that's a new plan, not a
patch. And racing plan mutations against live consumption is covered by
`tests/concurrency/plan-mutation-race.test.ts` (conservation:
account counter == Σ users == Σ accepted audit units, zero 5xx).

### Q16. Is this an append-only ledger or a mutable counter? Where's the OCC version column? Why one violation instead of a full rule trace?

**Ledger + snapshot, not a bare counter.** `consumption_records` IS the
immutable append-only ledger — one row per request, accepted *and*
rejected, carrying the frozen response payload. It's strictly richer than
a units-only event log because rejections are first-class history, and its
`UNIQUE (account_id, request_id)` makes the ledger and the idempotency
registry the *same* rows, so they can never diverge. `monthly_usage` is
the O(1) balance anchor — a materialized snapshot maintained **atomically
in the same transaction** as the ledger insert. Reconstruction is
therefore always provable: Σ accepted-record units for a `(user, period)`
equals the snapshot counter, an identity the concurrency suites and the
fast-check property stress assert directly.

**No `version` column, deliberately.** Version counters are for optimistic
concurrency — and OCC is the wrong tool at this system's exact hot spot:
500 contenders retrying against one row is a retry storm with unbounded
tail latency. Pessimistic `FOR UPDATE` queues are scheduled, bounded, and
make over-consumption impossible by construction. The ledger/snapshot
pair commits atomically, so there is no version reconciliation to get
wrong in the first place.

**One deterministic root cause, not a four-rule trace, on the wire.** The
evaluator checks all four rules with a documented precedence
(user/per-request → account/per-request → user/monthly → account/monthly)
and returns the single violated rule with full context — limit, requested,
current usage, and derived `remainingMonthly`. That *is* the trace's
`root_cause`, computed deterministically for identical inputs (essential
for replay equality). A full per-rule trace would bloat every stored
replay payload and every response for information the client can already
derive — and the precedence order means an evaluator seeing "user
per-request" already knows the other three were never the binding
constraint for this request. Randomized verification that the four rules
and their precedence behave correctly across thousands of generated cases
lives in `tests/unit/property.test.ts` (independent-model cross-check) and
`tests/integration/property-stress.test.ts` (live-API oracle streams with
mid-stream plan flips).

### Q17. What happens if the same idempotency key arrives with a different payload?

The audit-grade answer: **a 409, never a silent replay.** Every decision
stores `request_fingerprint` — SHA-256 over the canonical
`{accountId, userId, units}` — and every replay surface (pre-transaction
fast path, in-transaction re-check, and the 23505 race loser) compares it
before serving the stored decision. A mismatch means the client is reusing
a key for a *different* request: that's either a client bug or a probing
attempt, and returning the original decision would silently answer a
question the client never asked (Stripe calls this `idempotency_error`).

Note the security property it preserves: even before this guard, a
mismatched replay never *re-charged* anything — the stored decision was
served untouched, so double-spending was already impossible. The
fingerprint turns "safe but ambiguous" into "safe and explicit."
Legacy rows written before migration 003 (NULL fingerprint) keep replaying
as before, so the guard is backward-compatible. Regression:
`tests/concurrency/idempotency-race.test.ts` fires a 999-unit hijack
against a 2-unit decision with the same key — 409, zero charge, and the
same-payload retry still replays cleanly.

