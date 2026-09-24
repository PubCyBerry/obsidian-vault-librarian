import { type LibrarianSettings, mergeSettings } from '../types';

/** Marks a JSON file as this plugin's settings backup (LIB-FEAT-241). */
export const BACKUP_FORMAT = 'vault-librarian-settings';

export interface SettingsBackup {
	format: typeof BACKUP_FORMAT;
	exportedAt: string;
	pluginVersion: string;
	settings: Omit<LibrarianSettings, 'oauthHandoffs'>;
}

/**
 * Every setting, for a file in the vault. Keys go in only inside the sealed bundle, never in
 * plain text. Sign-ins waiting for another device stay out: they belong to this vault's devices
 * and to this moment. MCP sign-ins and chat history are not settings and are not in it.
 */
export function backupOf(
	settings: LibrarianSettings,
	pluginVersion: string,
	now = new Date(),
): SettingsBackup {
	const { oauthHandoffs: _handoffs, ...kept } = settings;
	return { format: BACKUP_FORMAT, exportedAt: now.toISOString(), pluginVersion, settings: kept };
}

/** The settings a backup file holds, filled with defaults the way the data file is, or why not. */
export function settingsFromBackup(text: string): LibrarianSettings | { error: string } {
	let parsed: Partial<SettingsBackup> | null;
	try {
		parsed = JSON.parse(text) as Partial<SettingsBackup> | null;
	} catch {
		return { error: 'This file is not JSON.' };
	}
	if (parsed?.format !== BACKUP_FORMAT || typeof parsed.settings !== 'object' || !parsed.settings)
		return { error: 'This file is not a Vault Librarian settings backup.' };
	const { oauthHandoffs: _handoffs, ...kept } = parsed.settings as LibrarianSettings;
	return mergeSettings(kept);
}

/** `Vault Librarian settings 2026-09-25 0105.json`, in local time. */
export function backupFileName(now = new Date()): string {
	const two = (n: number) => String(n).padStart(2, '0');
	const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
	return `Vault Librarian settings ${day} ${two(now.getHours())}${two(now.getMinutes())}.json`;
}
