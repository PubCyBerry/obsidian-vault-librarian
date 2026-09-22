import { normalizePath } from 'obsidian';

/**
 * Serializes mutations of one vault file, the way Pi's coding agent does with its
 * file-mutation-queue: calls on the same path run one after another, calls on different paths
 * still run in parallel. The snapshot before the change, the change and the hash after it all
 * happen inside the queued section, so two parallel writes to one note cannot interleave.
 */
const queues = new Map<string, Promise<void>>();

export function mutationQueueKey(path: string): string {
	return normalizePath(path.trim()).toLowerCase();
}

export async function withFileMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const key = mutationQueueKey(path);
	const previous = queues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const mine = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chained = previous.then(() => mine);
	queues.set(key, chained);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (queues.get(key) === chained) queues.delete(key);
	}
}

/** How many paths currently have a queued or running mutation; for tests. */
export function pendingMutationPaths(): number {
	return queues.size;
}
