-- ===========================================================================
-- 002_indexes.sql — performance composite indexes
--
-- Index consolidation note (interview-worthy deviation from reference DDL):
--
--   The reference DDL listed BOTH:
--     * UNIQUE constraints  unique_usage_period (account_id, user_id, period)
--       and unique_user_per_account (account_id, external_id)
--   and
--     * plain btree indexes idx_usage_lookup / idx_user_external_account
--       over the *identical column lists*.
--
--   PostgreSQL already implements every UNIQUE constraint with a backing
--   btree index, so duplicating them would double the write amplification
--   on our two hottest tables (monthly_usage is UPDATE-bound on every
--   consume request) with ZERO read benefit. We therefore keep only the
--   constraint-backed indexes and add the indexes that are *not* already
--   covered:
--
--     1. idx_usage_account_period — account-wide aggregation scans for a
--        period (the constraint index is ordered (account_id, user_id,
--        period) and cannot serve account+period-only range scans
--        efficiently). Because `units_consumed` is not part of it and the
--        row is narrow, updates can use HOT (heap-only tuple) paths.
--     2. idx_audit_history — spec-mandated audit history scan path.
--     3. idx_records_user_history — per-user history drilldown.
--
--   The idempotency lookup on consumption_records (account_id, request_id)
--   and the FOR UPDATE lookups on monthly_usage (account_id, user_id,
--   period) are already served by their UNIQUE constraint indexes.
-- ===========================================================================

-- Account-scoped history: most recent first, filtered by period.
CREATE INDEX idx_audit_history
    ON consumption_records (account_id, period, created_at DESC);

-- Per-user history drilldown within an account.
CREATE INDEX idx_records_user_history
    ON consumption_records (account_id, user_id, created_at DESC);

-- Account-wide usage aggregation for a period (all users + aggregate row).
CREATE INDEX idx_usage_account_period
    ON monthly_usage (account_id, period);
