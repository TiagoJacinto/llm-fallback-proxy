type TrySuccess<T> = [T, null];
type TryFailure<E> = [null, E];
type TryResult<T, E> = TrySuccess<T> | TryFailure<E>;

const toTrySuccess = <T>(data: T): TrySuccess<T> => [data, null];

const toTryFailure = <E>(error: E): TryFailure<E> => [null, error];

type Transformer<E> = (e: unknown) => E;

function defineTryPromise<E>(transformer: Transformer<E>) {
	return async <T>(promise: PromiseLike<T>): Promise<TryResult<T, E>> => {
		try {
			const data = await promise;
			return toTrySuccess(data);
		} catch (e) {
			return toTryFailure(transformer(e));
		}
	};
}

function defineTryFn<E>(transformer: Transformer<E>) {
	return <T>(fn: () => T): TryResult<T, E> => {
		try {
			const result = fn();
			return toTrySuccess(result);
		} catch (e) {
			return toTryFailure(transformer(e));
		}
	};
}

function defineTryAsyncFn<E>(transformer: Transformer<E>) {
	const tryPromise = defineTryPromise(transformer);
	return <T>(tryAsyncFn: () => PromiseLike<T>): Promise<TryResult<T, E>> =>
		tryPromise(tryAsyncFn());
}

const toError = (maybeError: unknown): Error => {
	if (maybeError instanceof Error) return maybeError;

	try {
		return new Error(JSON.stringify(maybeError));
	} catch {
		return new Error(String(maybeError));
	}
};

export function defineTry<E>(transformer: Transformer<E>) {
	return {
		promise: defineTryPromise(transformer),
		fn: defineTryFn(transformer),
		asyncFn: defineTryAsyncFn(transformer),
	};
}

export const Try = defineTry(toError);
