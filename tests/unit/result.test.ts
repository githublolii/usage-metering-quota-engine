import { describe, expect, it } from 'vitest';
import {
  andThen,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  match,
  ok,
  type Result,
  unwrapOr,
} from '../../src/domain/result.js';

describe('Result<T, E> monad', () => {
  it('ok() and err() construct discriminated unions', () => {
    const success = ok(42);
    const failure = err('boom');
    expect(success.ok).toBe(true);
    expect(success.value).toBe(42);
    expect(failure.ok).toBe(false);
    expect(failure.error).toBe('boom');
  });

  it('isOk / isErr narrow the union at compile time', () => {
    const result: Result<string, Error> = ok('yes');
    if (isOk(result)) {
      expect(result.value.length).toBe(3);
    } else {
      throw new Error('unreachable');
    }

    const failed: Result<number, Error> = err(new Error('nope'));
    if (isErr(failed)) {
      expect(failed.error.message).toBe('nope');
    } else {
      throw new Error('unreachable');
    }
  });

  it('map transforms only the success channel', () => {
    const success: Result<number, string> = ok(2);
    const mapped = map(success, (n: number) => n * 10);
    expect(isOk(mapped)).toBe(true);
    if (isOk(mapped)) expect(mapped.value).toBe(20);

    const failure: Result<number, string> = err('bad');
    const untouched = map(failure, (n: number) => n * 10);
    expect(isErr(untouched)).toBe(true);
    if (isErr(untouched)) expect(untouched.error).toBe('bad');
  });

  it('mapErr transforms only the error channel', () => {
    const failure: Result<number, string> = err('x');
    const mapped = mapErr(failure, (e) => `err:${e}`);
    expect(isErr(mapped)).toBe(true);
    if (isErr(mapped)) expect(mapped.error).toBe('err:x');

    const success: Result<number, string> = ok(1);
    const untouched = mapErr(success, (e) => `err:${e}`);
    expect(isOk(untouched)).toBe(true);
    if (isOk(untouched)) expect(untouched.value).toBe(1);
  });

  it('andThen chains fallible steps and short-circuits on the first error', () => {
    const double = (n: number): Result<number, string> => ok(n * 2);
    const halt = (_n: number): Result<number, string> => err('halted');

    const five: Result<number, string> = ok(5);
    const chained = andThen(andThen(five, double), double);
    expect(isOk(chained)).toBe(true);
    if (isOk(chained)) expect(chained.value).toBe(20);

    const short = andThen(andThen(five, halt), double);
    expect(isErr(short)).toBe(true);
    if (isErr(short)) expect(short.error).toBe('halted');
  });

  it('unwrapOr provides a fallback for errors and passes through successes', () => {
    const seven: Result<number, string> = ok(7);
    expect(unwrapOr(seven, 0)).toBe(7);
    const failure: Result<number, string> = err('x');
    expect(unwrapOr(failure, 0)).toBe(0);
  });

  it('match dispatches to exactly one branch', () => {
    const success: Result<number, string> = ok(10);
    expect(
      match(success, {
        ok: (v) => `value:${v}`,
        err: (e) => `error:${e}`,
      }),
    ).toBe('value:10');

    const failure: Result<number, string> = err('404');
    expect(
      match(failure, {
        ok: (v) => `value:${v}`,
        err: (e) => `error:${e}`,
      }),
    ).toBe('error:404');
  });

  it('supports a Result whose error channel is typed by usage', () => {
    const decision: Result<{ units: number }, { rule: string }> = err({
      rule: 'monthly_allowance',
    });
    expect(unwrapOr(decision, { units: 0 })).toEqual({ units: 0 });
  });
});
