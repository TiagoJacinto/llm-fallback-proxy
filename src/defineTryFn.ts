import { type Promisable } from 'type-fest';

const isPromiseLike = <T>(
  maybePromise: Promisable<T>,
): maybePromise is PromiseLike<T> =>
  maybePromise !== null &&
  typeof maybePromise === 'object' &&
  'then' in maybePromise &&
  typeof maybePromise.then === 'function';

type TrySuccess<T> = [T, null];
type TryFailure<E> = [null, E];
type TryResult<T, E> = TrySuccess<T> | TryFailure<E>;

function toTrySuccess<T>(data: T): TrySuccess<T> {
  return [data, null];
}

function toTryFailure<E>(error: E): TryFailure<E> {
  return [null, error];
}

const isNativePromise = <T>(value: Promisable<T>): value is Promise<T> => value instanceof Promise;

export function defineTryFn<E extends object>(transformer: (e: unknown) => E) {
  function tryWrapper<T>(
    tryFn: () => Promise<T>,
  ): Promise<TryResult<T, E>>;
  function tryWrapper<T>(tryFn: () => T): TryResult<T, E>;
  function tryWrapper<T>(tryFn: () => Promisable<T>): Promisable<TryResult<T, E>> {
    try {
      const result = tryFn();

      if (isNativePromise(result)) {
        return result
          .then((data) => toTrySuccess<T>(data))
          .catch((e) => toTryFailure<E>(transformer(e)));
      }

      if (isPromiseLike(result)) {
        return Promise.resolve(result)
          .then((data) => toTrySuccess<T>(data))
          .catch((e) => toTryFailure<E>(transformer(e)));
      }

      return toTrySuccess(result);
    } catch (e) {
      return toTryFailure(transformer(e));
    }
  }

  return tryWrapper;
}

const toError = (maybeError: unknown): Error => {
  if (maybeError instanceof Error) return maybeError;

  try {
    return new Error(JSON.stringify(maybeError));
  } catch {
    return new Error(String(maybeError));
  }
};

export const tryFn = defineTryFn(toError);