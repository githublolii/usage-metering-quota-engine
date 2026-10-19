-- ===========================================================================
-- 001_initial_schema.sql — Usage Metering & Quota Engine
--
-- Boyce-Codd Normal Form (BCNF) schema. See docs/ARCHITECTURE.md for the
-- full functional-dependency analysis proving BCNF/3NF compliance.
--
-- Notes on the schema:
--   1. `created_at/updated_at` default to plain `NOW()` on TIMESTAMPTZ
--      columns. An expression like `NOW() AT TIME ZONE 'UTC'`, which
--      produces a *naive* timestamp; storing it back into a TIMESTAMPTZ
--      column re-interprets it in the session timezone, silently shifting
--      audit timestamps on hosts not running UTC. `NOW()` alone stores the
--      correct instant on a TIMESTAMPTZ column regardless of session tz.
--   2. `plans.account_id` is created unconstrained and its FK is attached
--      after `accounts` exists — accounts ⇄ plans are *intentionally*
--      mutually referential (an account must have a plan; a custom plan
--      must have an owning account).
--   3. Plan-type binding integrity (ACCOUNT plans on accounts, USER plans
--      on users) is enforced by triggers — CHECK constraints cannot span
--      tables.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Plans
--    System-wide predefined plans have account_id NULL; custom plans are
--    tenant-scoped. A given plan name is unique within its scope and type.
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id           UUID, -- FK added after `accounts` exists (mutual reference)
    name                 VARCHAR(100) NOT NULL,
    type                 VARCHAR(20)  NOT NULL CHECK (type IN ('ACCOUNT', 'USER')),
    is_predefined        BOOLEAN      NOT NULL DEFAULT FALSE,
    monthly_allowance    INTEGER      NOT NULL CHECK (monthly_allowance >= 0),
    max_units_per_request INTEGER     NOT NULL CHECK (max_units_per_request > 0),
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_plan_name_scope UNIQUE NULLS NOT DISTINCT (account_id, name, type),
    CONSTRAINT plans_scope_shape CHECK (
        (is_predefined = TRUE  AND account_id IS NULL) OR
        (is_predefined = FALSE AND account_id IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- 2. Accounts
--    API keys are stored ONLY as SHA-256 hex digests (64 chars). The
--    plaintext key is returned exactly once at creation / rotation time.
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(255) NOT NULL,
    api_key_hash VARCHAR(64)  NOT NULL UNIQUE,
    plan_id      UUID         NOT NULL REFERENCES plans(id),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Close the intentional mutual reference (cyclic by design).
ALTER TABLE plans
    ADD CONSTRAINT plans_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Users — multi-tenant scoped by (account_id, external_id)
--    `external_id` is the caller-facing identifier supplied in consume
--    requests; the internal UUID is never trusted from outside.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    external_id VARCHAR(255) NOT NULL,
    plan_id     UUID         NOT NULL REFERENCES plans(id),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_user_per_account UNIQUE (account_id, external_id)
);

-- ---------------------------------------------------------------------------
-- 4. Monthly usage — additive monotonic counters (NOT balances)
--    One row per (account, user, period). user_id IS NULL marks the
--    account-wide aggregate row. `remaining` is always derived:
--      remaining = GREATEST(0, plan.monthly_allowance - units_consumed)
--    so mid-month plan downgrades can never corrupt history.
-- ---------------------------------------------------------------------------
CREATE TABLE monthly_usage (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id        UUID        REFERENCES users(id) ON DELETE CASCADE, -- NULL = account aggregate
    period         VARCHAR(7)  NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    units_consumed INTEGER     NOT NULL DEFAULT 0 CHECK (units_consumed >= 0),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_usage_period UNIQUE NULLS NOT DISTINCT (account_id, user_id, period)
);

-- ---------------------------------------------------------------------------
-- 5. Consumption records — audit trail AND idempotency log
--    The unique constraint on (account_id, request_id) is the single
--    source of truth for idempotency: one request key ⇒ one immutable
--    decision, enforced by the database even under parallel races.
-- ---------------------------------------------------------------------------
CREATE TABLE consumption_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id      VARCHAR(255) NOT NULL,
    units_requested INTEGER      NOT NULL CHECK (units_requested > 0),
    accepted        BOOLEAN      NOT NULL,
    rejection_reason TEXT,
    rejection_source VARCHAR(20) CHECK (rejection_source IN ('account', 'user')),
    rejection_rule   VARCHAR(50) CHECK (rejection_rule IN ('monthly_allowance', 'max_units_per_request')),
    period          VARCHAR(7)   NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    response_payload JSONB        NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_request_idempotency UNIQUE (account_id, request_id),
    CONSTRAINT rejection_shape CHECK (
        (accepted = TRUE
            AND rejection_reason IS NULL
            AND rejection_source IS NULL
            AND rejection_rule   IS NULL)
        OR
        (accepted = FALSE
            AND rejection_reason IS NOT NULL
            AND rejection_source IS NOT NULL
            AND rejection_rule   IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- 6. Referential integrity guards (plan-type binding)
--    CHECK constraints cannot reference other tables, so these triggers
--    make it *impossible* to bind an ACCOUNT plan to a user or a USER plan
--    to an account — even for hand-written SQL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_plan_type_binding() RETURNS trigger AS $$
DECLARE
    expected_type plans.type%TYPE;
    actual_type   plans.type%TYPE;
BEGIN
    IF TG_TABLE_NAME = 'accounts' THEN
        expected_type := 'ACCOUNT';
    ELSE
        expected_type := 'USER';
    END IF;

    SELECT type INTO actual_type FROM plans WHERE id = NEW.plan_id;

    IF actual_type IS DISTINCT FROM expected_type THEN
        RAISE EXCEPTION
            'plan % is of type %, but %s requires a %-type plan',
            NEW.plan_id, COALESCE(actual_type, '<missing>'), TG_TABLE_NAME, expected_type;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_plan_type_guard
    BEFORE INSERT OR UPDATE OF plan_id ON accounts
    FOR EACH ROW EXECUTE FUNCTION enforce_plan_type_binding();

CREATE TRIGGER users_plan_type_guard
    BEFORE INSERT OR UPDATE OF plan_id ON users
    FOR EACH ROW EXECUTE FUNCTION enforce_plan_type_binding();
