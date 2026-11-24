import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A Chromium browser already on the machine: CHROME_PATH, or where Chrome and Edge install. */
export const browserPath = [
	process.env.CHROME_PATH,
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((path) => path && existsSync(path));

/**
 * Loads a page in the headless browser and returns its DOM once its scripts have run, timers
 * and frames included. A profile of its own keeps it apart from a browser that is open.
 */
export function dumpDom(html: string): Promise<string> {
	if (!browserPath) throw new Error('No Chromium browser found; set CHROME_PATH');
	const dir = mkdtempSync(join(tmpdir(), 'librarian-layout-'));
	const page = join(dir, 'page.html');
	writeFileSync(page, html);
	const args = [
		'--headless=new',
		'--disable-gpu',
		'--window-size=1000,1300',
		`--user-data-dir=${join(dir, 'profile')}`,
		'--virtual-time-budget=10000',
		'--dump-dom',
		pathToFileURL(page).href,
	];
	// A CI runner does not let Chrome build its sandbox; the page is the one written above.
	if (process.env.CI) args.unshift('--no-sandbox');
	return new Promise((resolve, reject) => {
		execFile(
			browserPath,
			args,
			{ timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout) => {
				// A browser still letting go of its profile must not cost the results.
				try {
					rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
				} catch {}
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}
