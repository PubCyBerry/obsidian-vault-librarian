import { normalizePath } from 'obsidian';

/**
 * Paths Obsidian keeps out of its index: anything under a dot folder or the config folder
 * (whatever its name). The tools reach them through `vault.adapter` and never write there.
 */
export function isHiddenPath(path: string, configDir: string): boolean {
	const segments = path.split('/').filter(Boolean);
	return (
		segments[0]?.toLowerCase() === configDir.toLowerCase() ||
		segments.some((s) => s.startsWith('.'))
	);
}

/** Sub-agent definitions (LIB-FEAT-268), one of the two hidden places the agent may write in. */
export const AGENTS_DIR = '.agents/agents';

/** Folder that holds skills, at the vault root and in any folder up to SKILLS_DEPTH deep. */
export const SKILLS_DIR = '.agents/skills';
/** How deep the folder holding a SKILLS_DIR may be; the vault root is 0 (LIB-FEAT-120). */
export const SKILLS_DEPTH = 3;

/** A path inside the agent definitions folder, the folder itself, or `.agents` on the way to it. */
export function isAgentsPath(path: string): boolean {
	return path === '.agents' || path === AGENTS_DIR || path.startsWith(`${AGENTS_DIR}/`);
}

/**
 * A path in a skills folder (LIB-FEAT-283): a SKILLS_DIR where the scan finds skills, anything
 * under it, or the `.agents` on the way to it. The folders before it may not be hidden.
 */
export function isSkillsPath(path: string): boolean {
	const segments = path.split('/');
	const at = segments.indexOf('.agents');
	if (at < 0 || at > SKILLS_DEPTH || segments.slice(0, at).some((s) => s.startsWith('.')))
		return false;
	return segments.length === at + 1 || segments[at + 1] === 'skills';
}

/** Hidden places the agent may write in: the sub-agent definitions and the skills. */
export function isWritableHiddenPath(path: string): boolean {
	return isAgentsPath(path) || isSkillsPath(path);
}

/** Hidden and not a place the agent may write in: read-only for the agent. */
export function isReadOnlyPath(path: string, configDir: string): boolean {
	return isHiddenPath(path, configDir) && !isWritableHiddenPath(path);
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
	// "." segments go: models often write "./notes/a.md", and a kept "." reads as a dot folder.
	const segments = normalizePath(trimmed)
		.split('/')
		.filter((s) => s.length > 0 && s !== '.');
	if (segments.some((s) => s === '..'))
		throw new Error(`Parent traversal is not allowed: ${raw}`);
	if (segments.length === 0) {
		if (opts.allowRoot) return '';
		throw new Error('path must not be empty');
	}
	return segments.join('/');
}
