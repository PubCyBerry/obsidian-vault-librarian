import type { StoredOAuth } from './oauth-provider';

/**
 * One device's copy of a sign-in to a server (LIB-ADR-047): the tokens it holds, sealed with the
 * sync passphrase, or none where it signed out. A device without a sign-in takes the newest one
 * the others shared, so a sign-in made on a computer reaches the phones; a device follows the
 * newer copies of its own sign-in, so a token one device refreshed reaches the others before
 * they refresh the one it replaced.
 */
export interface SignInRecord {
	/** The device that wrote it. */
	device: string;
	/** When the tokens in it were made or refreshed, or the sign-in ended, in ms. */
	at: number;
	/** Which sign-in: made at a sign-in and kept through its refreshes (`StoredOAuth.grant`). */
	grant: string;
	/** `{ client, tokens }` sealed with the sync passphrase; absent after a sign-out. */
	sealed?: string;
}

/** The newest copy of one sign-in: `stored` is null where a device signed out of it. */
export interface SharedSignIn {
	device: string;
	at: number;
	grant: string;
	stored: StoredOAuth | null;
}

/**
 * Where the copies live: one folder per server, one file per device. A file has one writer, so
 * the vault's sync never has two versions of it to reconcile; a copy it made anyway is read too.
 */
export interface SignInFiles {
	/** Every file in the server's folder, copies the sync made of one included. */
	list(serverId: string): Promise<string[]>;
	read(path: string): Promise<string | null>;
	write(serverId: string, device: string, text: string): Promise<void>;
	remove(serverId: string, device: string): Promise<void>;
}

/** The part of Obsidian's DataAdapter the files need. */
interface Adapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
}

/** The files under `dir`, a folder in the plugin's own folder, which the vault's sync carries. */
export function adapterSignInFiles(adapter: Adapter, dir: string): SignInFiles {
	const folder = (serverId: string) => `${dir}/${serverId}`;
	const file = (serverId: string, device: string) => `${folder(serverId)}/${device}.json`;
	return {
		list: async (serverId) => {
			const path = folder(serverId);
			if (!(await adapter.exists(path))) return [];
			return (await adapter.list(path)).files.filter((f) => f.endsWith('.json'));
		},
		read: async (path) => {
			try {
				return await adapter.read(path);
			} catch {
				return null;
			}
		},
		write: async (serverId, device, text) => {
			if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
			if (!(await adapter.exists(folder(serverId)))) await adapter.mkdir(folder(serverId));
			await adapter.write(file(serverId, device), text);
		},
		remove: async (serverId, device) => {
			if (await adapter.exists(file(serverId, device)))
				await adapter.remove(file(serverId, device));
		},
	};
}

function parse(text: string | null): SignInRecord | null {
	if (!text) return null;
	try {
		const record = JSON.parse(text) as Partial<SignInRecord>;
		if (
			typeof record.device !== 'string' ||
			typeof record.at !== 'number' ||
			typeof record.grant !== 'string' ||
			(record.sealed !== undefined && typeof record.sealed !== 'string')
		)
			return null;
		return { device: record.device, at: record.at, grant: record.grant, sealed: record.sealed };
	} catch {
		return null;
	}
}

export interface SharedSignInsDeps {
	files: SignInFiles;
	/** Seals with this device's sync passphrase; null when it has none. */
	seal: (text: string) => Promise<string | null>;
	/** Opens with this device's sync passphrase; null when it cannot. */
	unseal: (sealed: string) => Promise<string | null>;
	deviceId: () => string;
}

/** The sign-ins the devices share, through files the vault's sync carries (LIB-FEAT-289). */
export class SharedSignIns {
	/** Opened copies by their sealed text: each costs a key derivation, so each is opened once. */
	private readonly opened = new Map<string, StoredOAuth>();
	/** Sealed texts this passphrase did not open; tried again after `reset`. */
	private readonly unopenable = new Set<string>();
	/** One write at a time per server, each with what the device holds by then. */
	private readonly writing = new Map<string, Promise<void>>();

	constructor(private readonly deps: SharedSignInsDeps) {}

	/** The passphrase changed: copies it could not open may open now. */
	reset(): void {
		this.unopenable.clear();
	}

	/**
	 * The newest copy of each sign-in the devices shared for the server. A sign-in whose newest
	 * copy this device cannot open is left out: an older copy would hold replaced tokens.
	 */
	async latest(serverId: string): Promise<SharedSignIn[]> {
		const newest = new Map<string, SignInRecord>();
		for (const path of await this.deps.files.list(serverId)) {
			const record = parse(await this.deps.files.read(path));
			const known = record && newest.get(record.grant);
			if (record && (!known || record.at > known.at)) newest.set(record.grant, record);
		}
		const out: SharedSignIn[] = [];
		for (const { device, at, grant, sealed } of newest.values()) {
			if (sealed === undefined) {
				out.push({ device, at, grant, stored: null });
				continue;
			}
			const stored = await this.open(sealed);
			if (stored) out.push({ device, at, grant, stored });
		}
		return out;
	}

	/** Shares the sign-in this device holds now, in its own file. */
	share(serverId: string, stored: StoredOAuth): Promise<void> {
		return this.write(serverId, async () => {
			if (!stored.tokens || stored.at === undefined || !stored.grant) return null;
			const sealed = await this.deps.seal(
				JSON.stringify({ client: stored.client, tokens: stored.tokens }),
			);
			return sealed
				? { device: this.deps.deviceId(), at: stored.at, grant: stored.grant, sealed }
				: null;
		});
	}

	/** Tells the devices on the same sign-in that this one signed out of it at `at`. */
	shareSignOut(serverId: string, at: number, grant: string): Promise<void> {
		return this.write(serverId, async () => ({ device: this.deps.deviceId(), at, grant }));
	}

	/** Removes this device's file, when the server is removed. */
	forget(serverId: string): Promise<void> {
		return this.queue(serverId, () => this.deps.files.remove(serverId, this.deps.deviceId()));
	}

	private write(serverId: string, make: () => Promise<SignInRecord | null>): Promise<void> {
		return this.queue(serverId, async () => {
			const record = await make();
			if (record)
				await this.deps.files.write(serverId, record.device, JSON.stringify(record));
		});
	}

	private queue(serverId: string, work: () => Promise<void>): Promise<void> {
		const next = (this.writing.get(serverId) ?? Promise.resolve())
			.then(work)
			.catch(() => undefined);
		this.writing.set(serverId, next);
		return next;
	}

	private async open(sealed: string): Promise<StoredOAuth | null> {
		const cached = this.opened.get(sealed);
		if (cached) return cached;
		if (this.unopenable.has(sealed)) return null;
		const text = await this.deps.unseal(sealed);
		let stored: StoredOAuth | null = null;
		try {
			const opened = text === null ? null : (JSON.parse(text) as StoredOAuth);
			if (opened?.tokens) stored = { client: opened.client, tokens: opened.tokens };
		} catch {
			stored = null;
		}
		if (stored) this.opened.set(sealed, stored);
		else this.unopenable.add(sealed);
		return stored;
	}
}
