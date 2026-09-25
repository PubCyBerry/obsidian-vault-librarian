import type { App } from 'obsidian';
import { normalizePath } from 'obsidian';
import type { ThinkingLevel } from '../types';
import type {
	IndexedEvent,
	SessionEvent,
	SessionEventInput,
	SessionMetadata,
	SessionSummary,
} from './session-types';

function pad(n: number, w = 2): string {
	return String(n).padStart(w, '0');
}

export function newSessionId(now = new Date()): string {
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Small, fast, non-cryptographic content hash used to detect edits made after the agent. */
export function contentHash(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 + c, 0x9e3779b1) >>> 0;
	}
	return `${h1.toString(16)}${h2.toString(16)}:${text.length}`;
}

export function parseEvents(text: string): SessionEvent[] {
	const events: SessionEvent[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as SessionEvent);
		} catch {
			// A torn line from an interrupted write is skipped, the rest of the file stays usable.
		}
	}
	return events;
}

/**
 * Events that are still part of the conversation: rewound ranges and summaries invalidated by a
 * rewind are dropped, but nothing is removed from the file.
 */
export function replay(events: SessionEvent[]): IndexedEvent[] {
	const dead = new Array<boolean>(events.length).fill(false);
	let earliestRewind = Number.POSITIVE_INFINITY;
	events.forEach((event, index) => {
		if (event.type !== 'rewind') return;
		for (let i = event.toEventIndex; i <= index; i++) dead[i] = true;
		earliestRewind = Math.min(earliestRewind, event.toEventIndex);
	});
	events.forEach((event, index) => {
		if (event.type === 'compaction' && !dead[index]) {
			// A summary that covered rewound events no longer describes the conversation.
			const rewoundInside = events.some(
				(e, j) => e.type === 'rewind' && j > index && e.toEventIndex < event.coveredUntil,
			);
			if (rewoundInside) dead[index] = true;
		}
	});
	void earliestRewind;
	const alive: IndexedEvent[] = [];
	events.forEach((event, index) => {
		if (!dead[index]) alive.push({ index, event });
	});
	return alive;
}

export function summarize(id: string, path: string, events: SessionEvent[]): SessionSummary | null {
	const meta = events.find(
		(e): e is Extract<SessionEvent, { type: 'meta' }> => e.type === 'meta',
	);
	if (!meta) return null;
	const alive = replay(events);
	let title = meta.session.title;
	let providerId = meta.session.providerId;
	let modelId = meta.session.modelId;
	let thinkingLevel = meta.session.thinkingLevel;
	let messageCount = 0;
	let firstUser: string | undefined;
	for (const { event } of alive) {
		if (event.type === 'rename') title = event.title;
		if (event.type === 'model_change') {
			providerId = event.providerId;
			modelId = event.modelId;
			thinkingLevel = event.thinkingLevel;
		}
		if (event.type === 'user' || event.type === 'assistant') messageCount++;
		if (event.type === 'user' && firstUser === undefined) firstUser = event.content;
	}
	if (!title && firstUser) title = firstUser.replace(/\s+/g, ' ').trim().slice(0, 60);
	const last = events[events.length - 1];
	const { parentId, parentCallId, agentName } = meta.session;
	return {
		id,
		path,
		title: title || 'New session',
		providerId,
		modelId,
		thinkingLevel,
		createdAt: meta.session.createdAt,
		updatedAt: last?.t ?? meta.session.createdAt,
		messageCount,
		...(parentId ? { parentId, parentCallId, agentName } : {}),
	};
}

export class SessionManager {
	private readonly summaries = new Map<
		string,
		{ mtime: number; size: number; summary: SessionSummary }
	>();

	constructor(
		private readonly app: App,
		private readonly pluginDir: string,
	) {}

	get sessionsDir(): string {
		return normalizePath(`${this.pluginDir}/sessions`);
	}

	get snapshotsDir(): string {
		return normalizePath(`${this.pluginDir}/snapshots`);
	}

	sessionPath(id: string): string {
		return normalizePath(`${this.sessionsDir}/${id}.jsonl`);
	}

	private async ensureDir(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(path))) await adapter.mkdir(path);
	}

	async create(
		meta: Omit<SessionMetadata, 'id' | 'createdAt' | 'updatedAt' | 'title'>,
	): Promise<SessionMetadata> {
		await this.ensureDir(this.pluginDir);
		await this.ensureDir(this.sessionsDir);
		const now = new Date().toISOString();
		const session: SessionMetadata = {
			id: newSessionId(),
			title: '',
			createdAt: now,
			updatedAt: now,
			...meta,
		};
		await this.app.vault.adapter.write(
			this.sessionPath(session.id),
			`${JSON.stringify({ t: now, type: 'meta', session })}\n`,
		);
		return session;
	}

	/** Appends one event and returns its index in the file. */
	async append(id: string, event: SessionEventInput): Promise<number> {
		const path = this.sessionPath(id);
		const line = JSON.stringify({ t: new Date().toISOString(), ...event });
		const before = await this.app.vault.adapter.read(path);
		const index = parseEvents(before).length;
		await this.app.vault.adapter.append(path, `${line}\n`);
		return index;
	}

	async load(id: string): Promise<SessionEvent[]> {
		const path = this.sessionPath(id);
		if (!(await this.app.vault.adapter.exists(path))) return [];
		return parseEvents(await this.app.vault.adapter.read(path));
	}

	async list(): Promise<SessionSummary[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.sessionsDir))) return [];
		const listing = await adapter.list(this.sessionsDir);
		const out: SessionSummary[] = [];
		for (const path of listing.files) {
			if (!path.endsWith('.jsonl')) continue;
			const id = path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length);
			const stat = await adapter.stat(path);
			const cached = this.summaries.get(id);
			if (cached && stat && cached.mtime === stat.mtime && cached.size === stat.size) {
				out.push(cached.summary);
				continue;
			}
			const summary = summarize(id, path, parseEvents(await adapter.read(path)));
			if (!summary) continue;
			if (stat) this.summaries.set(id, { mtime: stat.mtime, size: stat.size, summary });
			out.push(summary);
		}
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async summary(id: string): Promise<SessionSummary | null> {
		return summarize(id, this.sessionPath(id), await this.load(id));
	}

	async rename(id: string, title: string): Promise<void> {
		await this.append(id, { type: 'rename', title });
	}

	/** Deletes a session, its rewind snapshots and the sessions of the sub-agents it started. */
	async delete(id: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const children = (await this.list()).filter((s) => s.parentId === id);
		const path = this.sessionPath(id);
		if (await adapter.exists(path)) await adapter.remove(path);
		const snapDir = normalizePath(`${this.snapshotsDir}/${id}`);
		if (await adapter.exists(snapDir)) await adapter.rmdir(snapDir, true);
		this.summaries.delete(id);
		for (const child of children) await this.delete(child.id);
	}

	async recordModelChange(
		id: string,
		providerId: string,
		modelId: string,
		thinkingLevel?: ThinkingLevel,
	) {
		await this.append(id, { type: 'model_change', providerId, modelId, thinkingLevel });
	}

	/**
	 * Marks tool calls that were still waiting for approval when the session was left as expired,
	 * so reopening never resumes them. Returns the ids that were expired now.
	 */
	async expirePendingApprovals(id: string): Promise<string[]> {
		const events = await this.load(id);
		const decided = new Set<string>();
		for (const e of events) {
			if (e.type === 'approval' || e.type === 'tool_result') decided.add(e.toolCallId);
		}
		const expired: string[] = [];
		for (const { event } of replay(events)) {
			if (event.type === 'tool_call' && !decided.has(event.toolCallId)) {
				await this.append(id, {
					type: 'approval',
					toolCallId: event.toolCallId,
					name: event.name,
					decision: 'expired',
				});
				await this.append(id, {
					type: 'tool_result',
					toolCallId: event.toolCallId,
					name: event.name,
					ok: false,
					content: 'Approval expired',
					truncated: false,
				});
				expired.push(event.toolCallId);
			}
		}
		return expired;
	}

	// Snapshots hold a note's content from just before write/edit changed it.

	snapshotDirFor(id: string): string {
		return normalizePath(`${this.snapshotsDir}/${id}`);
	}

	async writeSnapshot(
		sessionId: string,
		eventIndex: number,
		notePath: string,
		content: string,
	): Promise<string> {
		await this.ensureDir(this.pluginDir);
		await this.ensureDir(this.snapshotsDir);
		const dir = this.snapshotDirFor(sessionId);
		await this.ensureDir(dir);
		const base = notePath.slice(notePath.lastIndexOf('/') + 1);
		// Agents working side by side can change two notes of one name before the log moves on.
		let ref = `${pad(eventIndex, 4)}-${base}`;
		for (let n = 2; await this.app.vault.adapter.exists(normalizePath(`${dir}/${ref}`)); n++)
			ref = `${pad(eventIndex, 4)}-${n}-${base}`;
		await this.app.vault.adapter.write(normalizePath(`${dir}/${ref}`), content);
		return ref;
	}

	async readSnapshot(sessionId: string, ref: string): Promise<string | null> {
		const path = normalizePath(`${this.snapshotDirFor(sessionId)}/${ref}`);
		if (!(await this.app.vault.adapter.exists(path))) return null;
		return this.app.vault.adapter.read(path);
	}

	async deleteSnapshot(sessionId: string, ref: string): Promise<void> {
		const path = normalizePath(`${this.snapshotDirFor(sessionId)}/${ref}`);
		if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
	}
}
