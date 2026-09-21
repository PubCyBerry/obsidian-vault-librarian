import { normalizePath } from 'obsidian';

/** Vault-relative, normalized path with the vault boundary rules applied. */
export function checkPath(
	raw: string,
	opts: { markdown?: boolean; allowRoot?: boolean; configDir: string },
): string {
	if (typeof raw !== 'string') throw new Error('path must be a string');
	const trimmed = raw.trim();
	if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^[\\/]/.test(trimmed) || /^~/.test(trimmed)) {
		throw new Error(`Absolute paths are not allowed: ${raw}`);
	}
	const path = normalizePath(trimmed);
	const segments = path.split('/').filter((s) => s.length > 0);
	if (segments.some((s) => s === '..'))
		throw new Error(`Parent traversal is not allowed: ${raw}`);
	const first = segments[0]?.toLowerCase();
	if (first === opts.configDir.toLowerCase() || first === '.trash') {
		throw new Error(`Access to ${segments[0]} is not allowed`);
	}
	if (segments.length === 0) {
		if (opts.allowRoot) return '';
		throw new Error('path must not be empty');
	}
	if (opts.markdown && !path.toLowerCase().endsWith('.md')) {
		throw new Error(`Only Markdown (.md) files are allowed: ${raw}`);
	}
	return path;
}
