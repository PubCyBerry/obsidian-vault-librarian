import { normalizePath } from 'obsidian';

/** Top-level folders the tools never see: the vault's config folder (whatever its name) and `.trash`. */
export function isHiddenRoot(name: string, configDir: string): boolean {
	const n = name.toLowerCase();
	return n === configDir.toLowerCase() || n === '.trash';
}

/** Files that are not text: read and grep skip them, mentions attach them by path or as images. */
const BINARY_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'bmp',
	'ico',
	'heic',
	'avif',
	'pdf',
	'mp3',
	'wav',
	'm4a',
	'ogg',
	'flac',
	'mp4',
	'mov',
	'webm',
	'mkv',
	'zip',
	'gz',
	'7z',
	'rar',
	'exe',
	'dll',
	'woff',
	'woff2',
	'ttf',
	'otf',
	'db',
	'sqlite',
]);

export function isBinaryPath(path: string): boolean {
	const dot = path.lastIndexOf('.');
	return dot >= 0 && BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** Vault-relative, normalized path with the vault boundary rules applied. */
export function checkPath(raw: string, opts: { allowRoot?: boolean; configDir: string }): string {
	if (typeof raw !== 'string') throw new Error('path must be a string');
	const trimmed = raw.trim();
	if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^[\\/]/.test(trimmed) || /^~/.test(trimmed)) {
		throw new Error(`Absolute paths are not allowed: ${raw}`);
	}
	const path = normalizePath(trimmed);
	const segments = path.split('/').filter((s) => s.length > 0);
	if (segments.some((s) => s === '..'))
		throw new Error(`Parent traversal is not allowed: ${raw}`);
	if (segments[0] !== undefined && isHiddenRoot(segments[0], opts.configDir)) {
		throw new Error(`Access to ${segments[0]} is not allowed`);
	}
	if (segments.length === 0) {
		if (opts.allowRoot) return '';
		throw new Error('path must not be empty');
	}
	return path;
}
