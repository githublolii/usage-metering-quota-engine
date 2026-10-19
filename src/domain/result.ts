/**
 * A minimal, fully-typed Result<T, E> monad.
 *
 * Why a Result type at all? The quota evaluator is 100% pure, and
 * "rejection" is an expected *business outcome*, not an exceptional control
 * flow. Forcing rejections through try/catch would make the evaluation
 * function's signature lie about its behavior; a discriminated union makes
 * every caller *at compile time* handle both branches.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Map the success channel, leaving errors untouched. */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Map the error channel, leaving successes untouched. */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Chain a fallible computation onto a success (the "then" of Result). */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** Provide a fallback value when the result is an error. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Invoke the matching branch and return its value. */
export function match<T, E, R>(
  result: Result<T, E>,
  handlers: {
    readonly ok: (value: T) => R;
    readonly err: (error: E) => R;
  },
): R {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}
