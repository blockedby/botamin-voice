export class AsyncQueue<T> implements AsyncIterable<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<{
		resolve(result: IteratorResult<T>): void;
		reject(error: Error): void;
	}> = [];
	private ended = false;
	private failure: Error | undefined;

	push(value: T): void {
		if (this.ended || this.failure) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ done: false, value });
		else this.values.push(value);
	}

	end(): void {
		if (this.ended || this.failure) return;
		this.ended = true;
		for (const waiter of this.waiters.splice(0))
			waiter.resolve({ done: true, value: undefined });
	}

	fail(error: Error): void {
		if (this.ended || this.failure) return;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: async (): Promise<IteratorResult<T>> => {
				const value = this.values.shift();
				if (value !== undefined) return { done: false, value };
				if (this.failure) throw this.failure;
				if (this.ended) return { done: true, value: undefined };
				return new Promise<IteratorResult<T>>((resolve, reject) => {
					this.waiters.push({ resolve, reject });
				});
			},
		};
	}
}
