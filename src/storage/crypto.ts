// Passphrase sealing for what this plugin carries between devices through the vault's own sync.
// The same format as Google Calendar Tasks Sync, so one passphrase serves both. WebCrypto only,
// so it runs unchanged on desktop and on phones.

function base64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const PREFIX = 'enc1.';
/** OWASP's recommended work factor for PBKDF2-HMAC-SHA256. Paid once per unlock per device. */
const ITERATIONS = 600_000;

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const raw = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passphrase),
		'PBKDF2',
		false,
		['deriveKey'],
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
		raw,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

/** `enc1.<salt>.<iv>.<ciphertext>` (base64url). PBKDF2-SHA256 to AES-256-GCM, fresh salt and IV every time. */
export async function encrypt(plain: string, passphrase: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveKey(passphrase, salt);
	const ct = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)),
	);
	return `${PREFIX}${base64url(salt)}.${base64url(iv)}.${base64url(ct)}`;
}

/** Rejects on a wrong passphrase or a damaged value (GCM authenticates the ciphertext). */
export async function decrypt(value: string, passphrase: string): Promise<string> {
	if (!value.startsWith(PREFIX)) throw new Error('Not a sealed value.');
	const [salt, iv, ct] = value.slice(PREFIX.length).split('.').map(fromBase64url);
	if (!salt || !iv || !ct) throw new Error('Malformed sealed value.');
	const key = await deriveKey(passphrase, salt);
	return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}
