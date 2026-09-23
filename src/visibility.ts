/**
 * Whether the app has been sent to the background, shared by everything that talks to the network.
 * A phone blocks requests started there (Android 15) and cuts open sockets once the app is frozen
 * (Android 14, ten seconds in), so a failure while away says nothing about the server or CORS.
 */

/** Told to the model when a call that is not safe to repeat broke while the app was away. */
export const AWAY_UNKNOWN =
	'The app was in the background, so it is unknown whether the server ran this call. Check before calling it again.';

let lastHiddenAt = 0;
const waiters = new Set<() => void>();

export function appIsHidden(): boolean {
	return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** The plugin feeds the document's `visibilitychange` here. */
export function noteVisibility(): void {
	if (appIsHidden()) {
		lastHiddenAt = Date.now();
		return;
	}
	releaseVisibilityWaiters();
}

/** True when the app was in the background at any moment since `since` (a `Date.now()` value). */
export function wasHiddenSince(since: number): boolean {
	return appIsHidden() || lastHiddenAt >= since;
}

/**
 * `work`, or a rejection the moment `signal` aborts. The work itself runs on (requestUrl cannot be
 * cancelled); only the caller stops waiting for it.
 */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(new Error('Operation aborted'));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error('Operation aborted'));
		signal.addEventListener('abort', onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

/**
 * Resolves when the app is in front again, or at once when it already is. With a `signal`, Stop
 * ends the wait: releasing the waiters on Stop does not reach one that starts afterwards.
 */
export function whenVisible(signal?: AbortSignal): Promise<void> {
	if (!appIsHidden()) return Promise.resolve();
	return abortable(new Promise<void>((resolve) => waiters.add(resolve)), signal);
}

/** Lets every waiter go, for a return to the app or a Stop that must not hang on it. */
export function releaseVisibilityWaiters(): void {
	const all = [...waiters];
	waiters.clear();
	for (const resolve of all) resolve();
}
