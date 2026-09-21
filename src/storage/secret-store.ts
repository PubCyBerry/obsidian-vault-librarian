import type { App } from 'obsidian';

export const SECRET_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function isValidSecretId(id: string): boolean {
	return SECRET_ID_PATTERN.test(id);
}

/** Thin wrapper over `app.secretStorage`. Keys live only on this device. */
export class SecretStore {
	constructor(private readonly app: App) {}

	/** `null` = not set on this device, `''` = connect without a key, otherwise the key. */
	get(id: string): string | null {
		if (!isValidSecretId(id)) return null;
		return this.app.secretStorage.getSecret(id);
	}

	set(id: string, value: string): void {
		if (!isValidSecretId(id)) throw new Error(`Invalid secret id: ${id}`);
		this.app.secretStorage.setSecret(id, value);
	}

	/** There is no delete in the public API, so a removed provider's key is overwritten with ''. */
	clear(id: string): void {
		if (isValidSecretId(id)) this.app.secretStorage.setSecret(id, '');
	}
}
