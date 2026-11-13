import type { ImageContent } from '@earendil-works/pi-ai';
import { type App, loadPdfJs } from 'obsidian';

/** A scratch file of the conversation's shell (`/tmp/…`) as bytes; null when there is none. */
export type ScratchReader = (path: string) => Promise<Uint8Array | null>;

/** A path in the shell's scratch space, which the vault's path rules do not cover. */
export function scratchPath(raw: string): string | null {
	const path = typeof raw === 'string' ? raw.trim() : '';
	// A `..` on the way could name a file elsewhere in the shell, such as the vault's own.
	return path.startsWith('/tmp/') && !path.split('/').includes('..') ? path : null;
}

const IMAGE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
};

/** The media type of a picture a model can be sent, by its extension. */
export function imageType(path: string): string | undefined {
	return IMAGE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
}

export function base64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** A file's bytes from the vault, hidden folders included, or from the scratch space. */
export async function readBytes(
	app: App,
	path: string,
	scratch?: ScratchReader,
): Promise<Uint8Array | null> {
	if (scratchPath(path)) return (await scratch?.(path)) ?? null;
	if ((await app.vault.adapter.stat(path))?.type !== 'file') return null;
	return new Uint8Array(await app.vault.adapter.readBinary(path));
}

/** A picture as a model takes it; null when the file is gone. A file that is no picture is a PNG. */
export async function loadImage(
	app: App,
	path: string,
	scratch?: ScratchReader,
): Promise<ImageContent | null> {
	const bytes = await readBytes(app, path, scratch);
	return (
		bytes && { type: 'image', data: base64(bytes), mimeType: imageType(path) ?? 'image/png' }
	);
}

interface PdfPage {
	getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }>;
}
interface PdfJs {
	getDocument(source: { data: Uint8Array }): {
		promise: Promise<{ numPages: number; getPage(n: number): Promise<PdfPage> }>;
	};
}

/**
 * The text of a PDF by Obsidian's own PDF.js, which a phone has too (LIB-FEAT-303): each page's
 * lines after a `--- page N ---` line. A scanned PDF has pages and no text.
 */
export async function pdfText(
	bytes: Uint8Array,
	first = 1,
	last = Number.POSITIVE_INFINITY,
): Promise<{ text: string; pages: number }> {
	const pdfjs = (await loadPdfJs()) as PdfJs;
	// PDF.js takes the buffer over, so it gets a copy of its own.
	const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
	const parts: string[] = [];
	for (let n = Math.max(1, first); n <= Math.min(doc.numPages, last); n++) {
		const { items } = await (await doc.getPage(n)).getTextContent();
		const text = items.map((i) => (i.str ?? '') + (i.hasEOL ? '\n' : '')).join('');
		parts.push(`--- page ${n} ---\n${text.trimEnd()}`);
	}
	return { text: parts.join('\n'), pages: doc.numPages };
}
