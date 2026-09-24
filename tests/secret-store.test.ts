import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/storage/crypto';
import { PASSPHRASE_ID, SecretStore, SHARED_PASSPHRASE_ID } from '../src/storage/secret-store';
import { FakeApp } from './fake-app';

const KEY = 'vault-librarian-openwebui';
const WEBDAV = 'vault-librarian-webdav';
const SIGN_IN = 'vault-librarian-mcp-outline-oauth';

/** Devices share only the settings the vault's sync carries; each has its own keychain. */
function devices() {
	const synced: { sealed?: string } = {};
	const device = () => {
		const app = new FakeApp();
		const store = new SecretStore(app as unknown as App, {
			read: () => synced.sealed,
			write: async (sealed) => {
				synced.sealed = sealed;
			},
			ids: () => [KEY, WEBDAV, SIGN_IN],
		});
		return { app, store };
	};
	return { synced, device };
}

describe('sealing (LIB-TEST-235)', () => {
	it('uses the Google Calendar Tasks Sync format and refuses another passphrase', async () => {
		const sealed = await encrypt('hello', 'pass');
		expect(sealed).toMatch(/^enc1\.[\w-]+\.[\w-]+\.[\w-]+$/);
		expect(await decrypt(sealed, 'pass')).toBe('hello');
		await expect(decrypt(sealed, 'other')).rejects.toThrow();
		// A fresh salt and IV every time.
		expect(await encrypt('hello', 'pass')).not.toBe(sealed);
	});
});

describe('secrets sealed for other devices (LIB-TEST-235)', () => {
	it('carries fixed secrets to a device with the same passphrase, never a sign-in', async () => {
		const { synced, device } = devices();
		const desktop = device();
		desktop.store.set(KEY, 'sk-desktop');
		desktop.store.set(WEBDAV, 'pw');
		desktop.store.set(SIGN_IN, '{"tokens":{"access_token":"a"}}');
		expect(synced.sealed).toBeUndefined();
		expect(await desktop.store.setPassphrase('same words')).toBe('on');
		expect(synced.sealed).toMatch(/^enc1\./);
		expect(await decrypt(synced.sealed!, 'same words')).not.toContain('access_token');
		expect(desktop.store.sealedCount()).toBe(2);

		// The phone has only Google Calendar Tasks Sync's passphrase, which is the same value.
		const phone = device();
		phone.app.secretStorage.setSecret(SHARED_PASSPHRASE_ID, 'same words');
		expect(phone.store.get(KEY)).toBeNull();
		expect(await phone.store.unlock()).toBe('on');
		expect(phone.store.usesSharedPassphrase).toBe(true);
		expect(phone.store.get(KEY)).toBe('sk-desktop');
		expect(phone.store.get(WEBDAV)).toBe('pw');
		expect(phone.store.get(SIGN_IN)).toBeNull();
		// Copied into the phone's keychain, so it keeps working without the passphrase.
		expect(phone.app.secretStorage.getSecret(KEY)).toBe('sk-desktop');
	});

	it('passes a change and a removal on, and a removed key stays removed', async () => {
		const { device } = devices();
		const desktop = device();
		desktop.store.set(KEY, 'old');
		await desktop.store.setPassphrase('pp');
		const phone = device();
		phone.app.secretStorage.setSecret(PASSPHRASE_ID, 'pp');
		await phone.store.unlock();
		expect(phone.store.get(KEY)).toBe('old');

		// Each device takes the other's bundle, as the plugin does when sync brings the settings.
		phone.store.set(KEY, 'new');
		await phone.store.unlock();
		await desktop.store.unlock();
		expect(desktop.store.get(KEY)).toBe('new');
		desktop.store.clear(KEY);
		await desktop.store.unlock();
		// The phone still holds 'new' in its keychain, but the bundle's '' wins and is not undone.
		await phone.store.unlock();
		expect(phone.store.get(KEY)).toBe('');
		expect(phone.app.secretStorage.getSecret(KEY)).toBe('');
	});

	it('keeps a passphrase that does not open the bundle out of the keychain', async () => {
		const { device } = devices();
		const desktop = device();
		desktop.store.set(KEY, 'k');
		await desktop.store.setPassphrase('right');
		const tablet = device();
		tablet.store.set(KEY, 'tablet-only');
		expect(await tablet.store.setPassphrase('wrong')).toBe('locked');
		expect(tablet.app.secretStorage.getSecret(PASSPHRASE_ID)).toBe('');
		expect(tablet.store.state).toBe('off');
		expect(tablet.store.hasBundle()).toBe(true);
		// Locked or off, the device goes on with what its own keychain holds.
		expect(tablet.store.get(KEY)).toBe('tablet-only');
	});
});
