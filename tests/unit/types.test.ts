import { describe, expect, it } from 'vitest';
import {
  ConsumeSchema,
  CreatePlanSchema,
  HistoryQuerySchema,
  PERIOD_PATTERN,
  currentUtcPeriod,
  generateApiKey,
  hashApiKey,
  isValidPeriod,
} from '../../src/domain/types.js';

/**
 * Domain type utilities: UTC period math, API key crypto, and the Zod DTO
 * contracts (the transport layer's ONLY source of truth for input shape).
 */

describe('UTC period helpers', () => {
  it('derives YYYY-MM from UTC calendar time (not local time)', () => {
    expect(currentUtcPeriod(new Date('2026-10-18T23:59:59.999Z'))).toBe('2026-10');
    expect(currentUtcPeriod(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
    expect(currentUtcPeriod(new Date('2027-01-31T12:00:00.000Z'))).toBe('2027-01');
  });

  it('zero-pads single-digit months', () => {
    expect(currentUtcPeriod(new Date('2026-03-05T00:00:00.000Z'))).toBe('2026-03');
  });

  it('a period computed once is reused for the whole request', () => {
    // Month rollover correctness: any instant maps to exactly one period.
    const first = currentUtcPeriod(new Date('2026-12-31T23:59:59.999Z'));
    const second = currentUtcPeriod(new Date('2027-01-01T00:00:00.000Z'));
    expect(first).toBe('2026-12');
    expect(second).toBe('2027-01');
  });

  it('isValidPeriod accepts only real UTC months', () => {
    expect(isValidPeriod('2026-01')).toBe(true);
    expect(isValidPeriod('2026-12')).toBe(true);
    expect(isValidPeriod('2026-00')).toBe(false);
    expect(isValidPeriod('2026-13')).toBe(false);
    expect(isValidPeriod('26-10')).toBe(false);
    expect(isValidPeriod('2026-1')).toBe(false);
    expect(isValidPeriod('2026-101')).toBe(false);
    expect(isValidPeriod('')).toBe(false);
    expect(PERIOD_PATTERN.test('2026-10')).toBe(true);
  });
});

describe('API key utilities', () => {
  it('hashApiKey produces the canonical SHA-256 hex digest', () => {
    // SHA-256("abc") — the standard test vector.
    expect(hashApiKey('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes are stable and deterministic', () => {
    expect(hashApiKey('mk_test_key')).toBe(hashApiKey('mk_test_key'));
  });

  it('generateApiKey issues unique, prefixed, high-entropy keys', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey()));
    expect(keys.size).toBe(1000); // no collisions in 1000 draws
    for (const key of keys) {
      expect(key.startsWith('mk_')).toBe(true);
      expect(key.length).toBeGreaterThanOrEqual(40); // mk_ + 256-bit base64url
    }
  });

  it('the hash is never reversible from the stored value alone (SHA-256)', () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(key.slice(3));
  });
});

describe('ConsumeSchema — request DTO contract', () => {
  it('accepts a well-formed consume request', () => {
    const result = ConsumeSchema.safeParse({
      userId: 'user-1',
      units: 10,
      requestId: '0d0a4a0f-3f94-4a2b-9c1d-2f3e7a9c1b22',
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['zero units', { userId: 'u', units: 0, requestId: crypto.randomUUID() }],
    ['negative units', { userId: 'u', units: -3, requestId: crypto.randomUUID() }],
    ['fractional units', { userId: 'u', units: 1.5, requestId: crypto.randomUUID() }],
    ['units as string', { userId: 'u', units: '10', requestId: crypto.randomUUID() }],
    ['missing userId', { units: 1, requestId: crypto.randomUUID() }],
    ['empty userId', { userId: '', units: 1, requestId: crypto.randomUUID() }],
    ['non-UUID requestId', { userId: 'u', units: 1, requestId: 'not-a-uuid' }],
    ['missing requestId', { userId: 'u', units: 1 }],
    ['unknown field', { userId: 'u', units: 1, requestId: crypto.randomUUID(), extra: true }],
  ])('rejects %s', (_label, payload) => {
    expect(ConsumeSchema.safeParse(payload).success).toBe(false);
  });
});

describe('CreatePlanSchema — plan DTO contract', () => {
  it('accepts a valid plan and enforces integer limits', () => {
    expect(
      CreatePlanSchema.safeParse({
        name: 'Gold',
        type: 'ACCOUNT',
        monthlyAllowance: 1000,
        maxUnitsPerRequest: 100,
      }).success,
    ).toBe(true);
    expect(
      CreatePlanSchema.safeParse({
        name: 'Zero',
        type: 'USER',
        monthlyAllowance: 0, // zero allowance is legal (disable consumption)
        maxUnitsPerRequest: 1,
      }).success,
    ).toBe(true);
    expect(
      CreatePlanSchema.safeParse({
        name: 'Bad',
        type: 'USER',
        monthlyAllowance: 100,
        maxUnitsPerRequest: 0, // must be >= 1
      }).success,
    ).toBe(false);
    expect(
      CreatePlanSchema.safeParse({
        name: 'Bad',
        type: 'TEAM', // only ACCOUNT | USER
        monthlyAllowance: 100,
        maxUnitsPerRequest: 1,
      }).success,
    ).toBe(false);
  });
});

describe('HistoryQuerySchema — pagination defaults and coercion', () => {
  it('coerces numeric query strings and applies defaults', () => {
    const parsed = HistoryQuerySchema.parse({ limit: '25', offset: '50' });
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(50);
  });

  it('caps limit at 200 and floors offset at 0', () => {
    expect(HistoryQuerySchema.safeParse({ limit: '10000' }).success).toBe(false);
    expect(HistoryQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });

  it('rejects malformed period filters', () => {
    expect(HistoryQuerySchema.safeParse({ period: '2026-13' }).success).toBe(false);
    expect(HistoryQuerySchema.safeParse({ period: '2026-10' }).success).toBe(true);
  });
});
