import { Platform } from 'obsidian';

/** The slice of Node's http module the loopback sign-in uses, typed here so no Node typings are needed. */
interface LoopbackResponse {
	writeHead(status: number, headers?: Record<string, string>): LoopbackResponse;
	end(body?: string): void;
}
interface LoopbackServer {
	listen(port: number, host: string, cb: () => void): void;
	address(): { port: number } | string | null;
	close(): void;
	closeAllConnections?(): void;
	once(event: 'error', cb: (e: Error) => void): void;
}
export interface HttpModule {
	createServer(handler: (req: { url?: string }, res: LoopbackResponse) => void): LoopbackServer;
}

/** Long enough to pick a site and read a consent screen. */
export const LOOPBACK_TIMEOUT_MS = 5 * 60_000;

/** Node's http on desktop, where Electron exposes require on window. Never touched on a phone. */
export function desktopHttp(): HttpModule | null {
	const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
	return Platform.isDesktopApp && nodeRequire ? (nodeRequire('http') as HttpModule) : null;
}

export interface Loopback {
	redirectUrl: string;
	close(): void;
}

export type LoopbackResult = { code: string } | { error: string };

/**
 * Listens on 127.0.0.1 for one OAuth redirect, the way desktop clients such as Claude Code sign
 * in: authorization servers accept a loopback address where they may refuse an `obsidian://` one.
 * Only a `/callback` whose state `accept`s counts; anything else gets a 404 and changes nothing.
 * The first real answer, or the timeout, closes the server.
 */
export function listenForRedirect(
	http: HttpModule,
	opts: {
		accept: (state: string | null) => boolean;
		onResult: (result: LoopbackResult) => void;
		timeoutMs?: number;
	},
): Promise<Loopback> {
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (result: LoopbackResult | null) => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			server.close();
			server.closeAllConnections?.();
			if (result) opts.onResult(result);
		};
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname !== '/callback' || !opts.accept(url.searchParams.get('state'))) {
				res.writeHead(404).end();
				return;
			}
			const code = url.searchParams.get('code') ?? '';
			// Echo nothing the server sent beyond plain words.
			const error = (
				url.searchParams.get('error_description') ??
				url.searchParams.get('error') ??
				''
			)
				.replace(/[^\w .,:-]/g, '')
				.slice(0, 200);
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(
				`<!doctype html><title>Vault Librarian</title><body style="font-family:sans-serif;padding:2em"><h2>${code ? 'Signed in. You can close this window and return to Obsidian.' : 'Sign-in failed.'}</h2>${error ? `<p>${error}</p>` : ''}</body>`,
			);
			finish(code ? { code } : { error: error || 'The server sent no code.' });
		});
		const timer = window.setTimeout(
			() => finish({ error: 'Timed out waiting for the browser.' }),
			opts.timeoutMs ?? LOOPBACK_TIMEOUT_MS,
		);
		server.once('error', (e) => {
			finish(null);
			reject(e);
		});
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			resolve({
				redirectUrl: `http://127.0.0.1:${port}/callback`,
				close: () => finish(null),
			});
		});
	});
}
