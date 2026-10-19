-- ===========================================================================
-- 003_request_fingerprint.sql — idempotency replay safety
--
-- Replaying an already-decided (account_id, request_id) is correct — but a
-- key reused with a DIFFERENT payload (userId/units) must not silently
-- return the ORIGINAL decision: that is ambiguous for callers and masks
-- client bugs (Stripe calls this idempotency_error).
--
-- Design:
--   Store a SHA-256 fingerprint of the canonical request payload alongside
--   the decision. On any replay (fast path, in-transaction re-check, or the
--   23505 race loser) the service compares fingerprints: a mismatch is a
--   409 CONFLICT problem+json — one idempotency key maps to exactly one
--   request. The double-spend guarantee is unaffected either way (a
--   mismatched replay was never re-charged); this removes the ambiguity.
--
--   The column is NULLABLE: rows written before this migration (fingerprint
--   NULL) keep replaying as before — legacy decisions never 409.
-- ===========================================================================

ALTER TABLE consumption_records
    ADD COLUMN request_fingerprint CHAR(64);

COMMENT ON COLUMN consumption_records.request_fingerprint IS
    'SHA-256 of the canonical {accountId, userId, units} request payload; '
    'NULL on legacy rows. Mismatch on replay => 409 idempotency conflict.';
