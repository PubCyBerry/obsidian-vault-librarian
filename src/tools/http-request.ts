import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
	htmlToMarkdown,
	type RequestUrlParam,
	type RequestUrlResponse,
	requestUrl,
} from 'obsidian';
import { Type } from 'typebox';
import type { LibrarianSettings } from '../types';
import { AWAY_UNKNOWN, wasHiddenSince, whenVisible } from '../visibility';
import { ok, throwIfAborted, tool } from './registry';

/** Safe to send twice (RFC 9110): a request that broke while the app was away is resent once. */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** Response headers a model uses: type, size, redirects, caching, pagination, rate limits. */
const KEPT_HEADERS =
	/^(content-type|content-length|content-disposition|location|last-modified|etag|link|retry-after|date|x-ratelimit-[\w-]+|ratelimit-[\w-]+|x-total-count)$/i;

const MAX_LINKS = 500;

export interface HttpDeps {
	settings: () => LibrarianSettings;
	/** Obsidian's `requestUrl` unless a test swaps it. */
	request?: (req: RequestUrlParam) => Promise<RequestUrlResponse>;
}

/** `http:<origin>` for a well-formed http(s) URL: one permission per site. */
export function httpPermissionKey(args: unknown): string | null {
	const url = (args as { url?: unknown } | null)?.url;
	if (typeof url !== 'string') return null;
	try {
		const u = new URL(url);
		return u.protocol === 'http:' || u.protocol === 'https:' ? `http:${u.origin}` : null;
	} catch {
		return null;
	}
}

function isText(contentType: string): boolean {
	return /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|charset=/i.test(
		contentType,
	);
}

function headerValue(headers: Record<string, string>, name: string): string {
	const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
	return key ? headers[key]! : '';
}

function absolute(href: string | null, base: string): string | null {
	if (!href) return null;
	try {
		return new URL(href, base).href;
	} catch {
		return null;
	}
}

export interface PageLink {
	text: string;
	url: string;
}

/**
 * A web page as Markdown for reading and following links. Scripts, styles and page chrome are
 * dropped, `<main>` or `<article>` is preferred over the whole body, and every link is made
 * absolute so the model can request it as is.
 * ponytail: tag-based cleanup, no readability scoring; add a content extractor (Defuddle) if pages read noisy.
 */
export function pageToMarkdown(
	html: string,
	pageUrl: string,
): { title: string; markdown: string; links: PageLink[] } {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const base = absolute(doc.querySelector('base[href]')?.getAttribute('href') ?? null, pageUrl);
	const baseUrl = base ?? pageUrl;
	const links: PageLink[] = [];
	const seen = new Set<string>();
	for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
		const url = absolute(a.getAttribute('href'), baseUrl);
		if (!url) continue;
		a.setAttribute('href', url);
		const page = url.split('#')[0]!;
		if (!/^https?:/i.test(url) || seen.has(page) || page === pageUrl.split('#')[0]) continue;
		seen.add(page);
		links.push({ text: (a.textContent ?? '').replace(/\s+/g, ' ').trim(), url });
	}
	for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
		const src = absolute(img.getAttribute('src'), baseUrl);
		if (src) img.setAttribute('src', src);
	}
	for (const el of Array.from(
		doc.querySelectorAll(
			'script, style, noscript, template, iframe, svg, canvas, form, nav, header, footer, aside',
		),
	))
		el.remove();
	const root = doc.querySelector<HTMLElement>('main, article, [role="main"]') ?? doc.body;
	return {
		title: (doc.title ?? '').trim(),
		markdown: root ? htmlToMarkdown(root).trim() : '',
		links,
	};
}

export function createHttpRequestTool(deps: HttpDeps): AgentTool {
	const send = deps.request ?? ((req: RequestUrlParam) => requestUrl(req));
	// The body window leaves room in the tool result for the status, headers and paging fields.
	const bodyWindow = () => Math.max(1000, deps.settings().toolResultMaxChars - 2000);
	return tool({
		name: 'http_request',
		label: 'HTTP request',
		description:
			'Send an HTTP request to any http or https URL and return the status, the useful headers and the body. Works for REST APIs and web pages alike. Use format "markdown" to read a web page as Markdown with absolute links, and follow a link by requesting its URL. Pages that build their content with JavaScript show little text. A long body comes in windows: pass nextOffset as offset to continue.',
		parameters: Type.Object({
			url: Type.String({ description: 'Absolute http or https URL.' }),
			method: Type.Optional(
				Type.Union(
					[
						Type.Literal('GET'),
						Type.Literal('HEAD'),
						Type.Literal('POST'),
						Type.Literal('PUT'),
						Type.Literal('PATCH'),
						Type.Literal('DELETE'),
						Type.Literal('OPTIONS'),
					],
					{ description: 'Default GET.' },
				),
			),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), { description: 'Request headers.' }),
			),
			body: Type.Optional(Type.String({ description: 'Request body.' })),
			format: Type.Optional(
				Type.Union([Type.Literal('text'), Type.Literal('markdown')], {
					description:
						'text returns the body as received. markdown turns an HTML page into Markdown. Default text.',
				}),
			),
			links: Type.Optional(
				Type.Boolean({
					description: `With format markdown, also return the page links as a list (up to ${MAX_LINKS}). Default false.`,
				}),
			),
			offset: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: 'Character offset into the body. Default 0.',
				}),
			),
			max_chars: Type.Optional(
				Type.Integer({
					minimum: 100,
					maximum: 1_000_000,
					description: `Characters of body to return. Default ${bodyWindow()}.`,
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 300,
					description: 'Seconds to wait for the response. Default 60.',
				}),
			),
		}),
		executionMode: 'sequential',
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				throw new Error(`Not a URL: ${params.url}`);
			}
			if (url.protocol !== 'http:' && url.protocol !== 'https:')
				throw new Error(`Only http and https URLs are allowed: ${params.url}`);
			const method = params.method ?? 'GET';
			const req: RequestUrlParam = {
				url: url.href,
				method,
				headers: params.headers ?? {},
				...(params.body !== undefined ? { body: params.body } : {}),
				throw: false,
			};
			const seconds = params.timeout ?? 60;
			// requestUrl cannot be cancelled, so a late response is simply dropped.
			const once = async () => {
				let timer = 0;
				try {
					return await Promise.race([
						send(req),
						new Promise<never>((_, reject) => {
							timer = window.setTimeout(
								() => reject(new Error(`No response after ${seconds} seconds`)),
								seconds * 1000,
							);
						}),
					]);
				} finally {
					window.clearTimeout(timer);
				}
			};
			const startedAt = Date.now();
			let response: RequestUrlResponse;
			try {
				response = await once();
			} catch (error) {
				// A phone freezes the connection of an app in the background; that is not the server.
				if (signal?.aborted || !wasHiddenSince(startedAt)) throw error;
				const message = error instanceof Error ? error.message : String(error);
				if (!IDEMPOTENT.has(method)) throw new Error(`${message}. ${AWAY_UNKNOWN}`);
				await whenVisible();
				throwIfAborted(signal);
				response = await once();
			}
			throwIfAborted(signal);
			const headers = Object.fromEntries(
				Object.entries(response.headers ?? {}).filter(([k]) => KEPT_HEADERS.test(k)),
			);
			const contentType = headerValue(response.headers ?? {}, 'content-type');
			const base = { url: url.href, status: response.status, headers };
			if (method === 'HEAD') return ok(base);
			if (contentType && !isText(contentType))
				return ok({ ...base, contentType, bytes: response.arrayBuffer.byteLength });
			let body = response.text;
			const extra: Record<string, unknown> = {};
			if (params.format === 'markdown' && /html/i.test(contentType || 'text/html')) {
				const page = pageToMarkdown(body, url.href);
				body = page.markdown;
				if (page.title) extra.title = page.title;
				if (params.links) {
					extra.links = page.links.slice(0, MAX_LINKS);
					extra.linkCount = page.links.length;
				}
			}
			const offset = params.offset ?? 0;
			const size = params.max_chars ?? bodyWindow();
			const slice = body.slice(offset, offset + size);
			const next = offset + slice.length;
			return ok({
				...base,
				...extra,
				body: slice,
				bodyLength: body.length,
				...(offset ? { offset } : {}),
				...(next < body.length ? { nextOffset: next } : {}),
			});
		},
	});
}
