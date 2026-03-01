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

type Transformer<E> = (e: unknown) => E;

export function defineTryPromise<E>(transformer: Transformer<E>) {
  return async function tryPromise<T>(promise: PromiseLike<T>): Promise<TryResult<T, E>> {
    try {
      const data = await promise;
      return toTrySuccess(data);
    } catch (e) {
      return toTryFailure(transformer(e));
    }
  }
}

export function defineTryFn<E>(transformer: Transformer<E>) {
  const tryPromise = defineTryPromise(transformer);

  function tryWrapper<T>(promise: PromiseLike<T>): Promise<TryResult<T, E>>;
  function tryWrapper<T>(tryFn: () => T): TryResult<T, E>;
  function tryWrapper<T>(tryFn: ((() => T)| PromiseLike<T>)) {
    try {
      const result = typeof tryFn === 'function' ? tryFn() : tryFn;

      if (isNativePromise(result)) return tryPromise(result);
      if (isPromiseLike(result)) return tryPromise(Promise.resolve(result));

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