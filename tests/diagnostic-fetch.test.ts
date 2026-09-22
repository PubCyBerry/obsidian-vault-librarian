import { describe, expect, it } from 'vitest';
import { createDiagnosticFetch } from '../src/provider/transport';

describe('diagnostic fetch (LIB-TEST-130)', () => {
	it('reports a request that never got a response', async () => {
		const diag = createDiagnosticFetch(async () => {
			throw new TypeError('Failed to fetch');
		});
		await expect(diag.fetch('https://x/')).rejects.toThrow('Failed to fetch');
		expect(diag.describe()).toMatch(
			/^fetch, after \d+\.\d s, no response, TypeError: Failed to fetch$/,
		);
	});

	it('reports the status and the bytes read before the body broke', async () => {
		const diag = createDiagnosticFetch(async () => {
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (!('sent' in controller)) {
						(controller as { sent?: boolean }).sent = true;
						controller.enqueue(new Uint8Array([1, 2, 3]));
					} else controller.error(new TypeError('network error'));
				},
			});
			return new Response(body, { status: 200 });
		});
		const response = await diag.fetch('https://x/');
		const reader = response.body!.getReader();
		expect((await reader.read()).value).toHaveLength(3);
		await expect(reader.read()).rejects.toThrow('network error');
		expect(diag.describe()).toMatch(
			/^fetch, after \d+\.\d s, HTTP 200 received, body cut after 3 bytes, TypeError: network error$/,
		);
	});
});
