import type { App } from 'obsidian';
import { decrypt, encrypt } from './crypto';

export const SECRET_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function isValidSecretId(id: string): boolean {
	return SECRET_ID_PATTERN.test(id);
}

/** This device's sync passphrase, in its own keychain only. */
export const PASSPHRASE_ID = 'vault-librarian-sync-passphrase';

/**
 * The passphrase Google Calendar Tasks Sync keeps in the same keychain. Both plugins seal the same
 * way, so a device where that one is unlocked needs no second entry (LIB-ADR-031).
 */
export const SHARED_PASSPHRASE_ID = 'google-cal-sync-passphrase';

/** `off`: no passphrase on this device. `locked`: it does not open the bundle. `on`: open. */
export type SyncState = 'off' | 'locked' | 'on';

/** Where the sealed bundle lives, and which secrets belong in it. */
export interface SealHost {
	read: () => string | undefined;
	write: (sealed: string) => Promise<void>;
	/** The fixed secrets in use: provider keys, MCP keys and client secrets, the WebDAV password. */
	ids: () => string[];
}

/**
 * Whether a secret travels in the sealed bundle. A sign-in (`-oauth`) does not: its refresh token
 * changes on every use, and two devices refreshing one grant undo each other (LIB-ADR-031).
 */
export function sealable(id: string): boolean {
	return !id.endsWith('-oauth') && id !== PASSPHRASE_ID && id !== SHARED_PASSPHRASE_ID;
}

/**
 * Secrets over `app.secretStorage`, which stays on this device. With a sync passphrase the fixed
 * secrets also live in a bundle sealed into the plugin's data file, which the vault's sync carries
 * to the other devices; there the bundle wins over what the device holds (LIB-FEAT-233).
 */
export class SecretStore {
	state: SyncState = 'off';
	/** Whether the passphrase in use is the one Google Calendar Tasks Sync saved. */
	usesSharedPassphrase = false;
	/** The opened bundle, while `on`. */
	private bundle: Map<string, string> | null = null;
	private sealing: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly app: App,
		private readonly host?: SealHost,
	) {}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** `null` = not set on this device, `''` = connect without a key, otherwise the key. */
	get(id: string): string | null {
		if (!isValidSecretId(id)) return null;
		const sealed = sealable(id) ? this.bundle?.get(id) : undefined;
		return sealed ?? this.app.secretStorage.getSecret(id);
	}

	set(id: string, value: string): void {
		if (!isValidSecretId(id)) throw new Error(`Invalid secret id: ${id}`);
		this.app.secretStorage.setSecret(id, value);
		if (!this.bundle || !sealable(id) || this.bundle.get(id) === value) return;
		this.bundle.set(id, value);
		this.reseal();
	}

	/**
	 * There is no delete in the public API, so a removed key is overwritten with ''. In the bundle
	 * the '' stays too, so a device that still holds the old key does not put it back.
	 */
	clear(id: string): void {
		if (isValidSecretId(id)) this.set(id, '');
	}

	/** A bundle is in the data file, whether or not this device can open it. */
	hasBundle(): boolean {
		return !!this.host?.read();
	}

	/** Fixed secrets in the open bundle that hold a value. */
	sealedCount(): number {
		return this.bundle ? [...this.bundle.values()].filter(Boolean).length : 0;
	}

	/**
	 * Opens the bundle with this device's passphrase. Secrets this device holds that the bundle
	 * lacks go into it, so the first device to unlock seeds it; the bundle's values are copied into
	 * this device's keychain, so it keeps working if the passphrase is later removed.
	 */
	async unlock(): Promise<SyncState> {
		// A change still being sealed would otherwise be read back as the old bundle and lost.
		await this.sealing;
		const passphrase = this.passphrase();
		if (!this.host || !passphrase) return this.settle(null, 'off');
		const stored = this.host.read();
		let bundle = new Map<string, string>();
		if (stored) {
			try {
				const opened = JSON.parse(await decrypt(stored, passphrase)) as Record<
					string,
					string
				>;
				bundle = new Map(Object.entries(opened));
			} catch {
				return this.settle(null, 'locked');
			}
		}
		let added = false;
		for (const id of this.host.ids()) {
			if (!sealable(id) || bundle.has(id)) continue;
			const local = this.app.secretStorage.getSecret(id);
			if (!local) continue;
			bundle.set(id, local);
			added = true;
		}
		for (const [id, value] of bundle)
			if (isValidSecretId(id) && this.app.secretStorage.getSecret(id) !== value)
				this.app.secretStorage.setSecret(id, value);
		this.settle(bundle, 'on');
		if (added) this.reseal();
		await this.sealing;
		return this.state;
	}

	/**
	 * Saves a passphrase for this device and unlocks with it. One that does not open the bundle
	 * another device sealed is not kept: `locked` comes back and the old one stays.
	 */
	async setPassphrase(value: string): Promise<SyncState> {
		const previous = this.app.secretStorage.getSecret(PASSPHRASE_ID) ?? '';
		this.app.secretStorage.setSecret(PASSPHRASE_ID, value);
		const state = await this.unlock();
		if (state !== 'locked') return state;
		this.app.secretStorage.setSecret(PASSPHRASE_ID, previous);
		await this.unlock();
		return 'locked';
	}

	/** Resolves once every change so far is sealed into the settings. */
	settled(): Promise<void> {
		return this.sealing;
	}

	/** Seals any text with this device's passphrase; null when it has none. */
	async seal(text: string): Promise<string | null> {
		const passphrase = this.passphrase();
		return passphrase ? await encrypt(text, passphrase) : null;
	}

	/** Opens a sealed text; null when this device has no passphrase or not the right one. */
	async unseal(sealed: string): Promise<string | null> {
		const passphrase = this.passphrase();
		if (!passphrase) return null;
		try {
			return await decrypt(sealed, passphrase);
		} catch {
			return null;
		}
	}

	private passphrase(): string | null {
		const own = this.app.secretStorage.getSecret(PASSPHRASE_ID);
		const shared = own ? null : this.app.secretStorage.getSecret(SHARED_PASSPHRASE_ID);
		this.usesSharedPassphrase = !own && !!shared;
		return own || shared || null;
	}

	/** Writes the bundle again. One write at a time, each with the bundle as it is by then. */
	private reseal(): void {
		const host = this.host;
		const bundle = this.bundle;
		const passphrase = this.passphrase();
		if (!host || !bundle || !passphrase) return;
		this.sealing = this.sealing
			.then(async () =>
				host.write(await encrypt(JSON.stringify(Object.fromEntries(bundle)), passphrase)),
			)
			.catch(() => undefined);
	}

	private settle(bundle: Map<string, string> | null, state: SyncState): SyncState {
		this.bundle = bundle;
		this.state = state;
		for (const listener of this.listeners) listener();
		return state;
	}
}
