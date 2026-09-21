import { requestUrl } from 'obsidian';

/**
 * A `fetch` built on Obsidian's `requestUrl` for MCP servers that do not allow the Obsidian origin
 * through CORS. It cannot stream, so the server-to-client event stream (a GET for
 * `text/event-stream`) is answered with 405 locally, which the MCP client treats as "not offered".
 */
export async function requestUrlFetch(input: string | URL, init?: RequestInit): Promise<Response> {
	const method = (init?.method ?? 'GET').toUpperCase();
	const headers = new Headers(init?.headers);
	if (method === 'GET' && (headers.get('accept') ?? '').includes('text/event-stream'))
		return new Response(null, { status: 405 });
	const body =
		typeof init?.body === 'string'
			? init.body
			: init?.body instanceof URLSearchParams
				? init.body.toString()
				: undefined;
	const response = await requestUrl({
		url: String(input),
		method,
		headers: headerRecord(headers),
		body,
		throw: false,
	});
	const empty = response.status === 204 || response.status === 205 || response.status === 304;
	return new Response(empty ? null : response.arrayBuffer, {
		status: response.status,
		headers: response.headers,
	});
}

/** True for the failure `fetch` raises before any response arrives (CORS, DNS, refused). */
export function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError;
}

function headerRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}
