import { describe, expect, it } from 'vitest';
import {
	BACKUP_FORMAT,
	backupFileName,
	backupOf,
	settingsFromBackup,
} from '../src/settings/backup';
import { mergeSettings } from '../src/types';

describe('settings backup (LIB-TEST-242)', () => {
	it('keeps every setting and the sealed keys, and leaves hand-overs out', () => {
		const settings = mergeSettings({
			mcpServers: [
				{
					id: 'srv',
					name: 'Server',
					url: 'https://mcp.example/mcp',
					auth: 'oauth',
					enabled: true,
					toolHashes: {},
				},
			],
			webdav: { enabled: true, url: 'https://nas.example/dav', username: 'me' },
			sealedSecrets: 'enc1.salt.iv.ct',
			oauthHandoffs: {
				srv: {
					from: 'desk',
					nonce: 'n',
					sealed: 'enc1.x',
					createdAt: '2026-09-25T00:00:00Z',
				},
			},
		});
		settings.toolPermissions.byTool.bash = 'always_allow';
		const text = JSON.stringify(backupOf(settings, '2.11.0', new Date('2026-09-25T01:05:00Z')));
		expect(JSON.parse(text)).toMatchObject({
			format: BACKUP_FORMAT,
			pluginVersion: '2.11.0',
			exportedAt: '2026-09-25T01:05:00.000Z',
		});
		expect(text).not.toContain('oauthHandoffs');

		const back = settingsFromBackup(text);
		if ('error' in back) throw new Error(back.error);
		expect(back.mcpServers.map((s) => s.id)).toEqual(['srv']);
		expect(back.webdav).toMatchObject({ enabled: true, url: 'https://nas.example/dav' });
		expect(back.sealedSecrets).toBe('enc1.salt.iv.ct');
		expect(back.toolPermissions.byTool.bash).toBe('always_allow');
		expect(back.oauthHandoffs).toBeUndefined();
	});

	it('refuses a file that is not a backup, and a hand-over slipped into one', () => {
		expect(settingsFromBackup('not json')).toEqual({ error: 'This file is not JSON.' });
		expect(settingsFromBackup('{"providers":[]}')).toEqual({
			error: 'This file is not a Vault Librarian settings backup.',
		});
		const edited = settingsFromBackup(
			JSON.stringify({ format: BACKUP_FORMAT, settings: { oauthHandoffs: { srv: {} } } }),
		);
		expect('error' in edited ? edited : edited.oauthHandoffs).toBeUndefined();
	});

	it('names the file by the local date and minute', () => {
		expect(backupFileName(new Date(2026, 8, 25, 1, 5))).toBe(
			'Vault Librarian settings 2026-09-25 0105.json',
		);
	});
});
