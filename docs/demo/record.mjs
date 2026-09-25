// Records the README media from the demo vault into docs/media:
//
//   npm run build && node docs/demo/record.mjs
//   node docs/demo/record.mjs media    # only turn the last recording into media again
//
// Needs Obsidian open with its command line interface turned on, OPENAI_API_KEY in the
// environment Obsidian was started with (the demo runs GPT-6 Luna), and ffmpeg and ImageMagick
// (`magick`) on PATH. The demo vault opens in a window of its own, which stays on top while it
// records. Its notes are reset to what git has before each pass.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const VAULT = join(HERE, 'Work');
const OUT = join(HERE, 'out');
const MEDIA = join(ROOT, 'docs', 'media');
const posix = (p) => p.replaceAll('\\', '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs JavaScript in a vault window (the demo vault unless `vault` is null) and returns its value. */
function obsidian(code, vault = 'Work') {
	const out = execFileSync(
		'obsidian',
		[...(vault ? [`vault=${vault}`] : []), 'eval', `code=${code}`],
		{ encoding: 'utf8' },
	);
	const at = out.indexOf('=> ');
	return at === -1 ? out.trim() : out.slice(at + 3).trim();
}

function tryObsidian(code) {
	try {
		return obsidian(code);
	} catch {
		return null;
	}
}

async function until(check, what, ms = 60000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await sleep(500);
	}
}

function run(command, args) {
	execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

/** The notes as git has them, without the ones the scenes create. */
function resetNotes() {
	run('git', ['checkout', '--', 'docs/demo/Work']);
	for (const made of ['Inbox/Action items.md', '.trash'])
		rmSync(join(VAULT, made), { recursive: true, force: true });
}

async function record() {
	// The UI language and mobile emulation live in localStorage, which every vault window
	// shares. The demo window reads them as it loads, then they go back to what the user had.
	const shared = JSON.parse(
		obsidian(
			`JSON.stringify({ language: localStorage.getItem('language'), mobile: localStorage.getItem('EmulateMobile') })`,
			null,
		),
	);
	const restore = (key, value) =>
		value === null
			? `localStorage.removeItem('${key}')`
			: `localStorage.setItem('${key}', ${JSON.stringify(value)})`;

	async function reload({ mobile = false, width = 1440, height = 900 } = {}) {
		obsidian(
			`require('electron').remote.getCurrentWindow().setContentSize(${width}, ${height}); localStorage.setItem('language', 'en'); ${mobile ? "localStorage.setItem('EmulateMobile', '1')" : "localStorage.removeItem('EmulateMobile')"}; setTimeout(() => location.reload(), 200); 'reloading'`,
		);
		await sleep(2000);
		await until(
			() =>
				tryObsidian(`String(!!app.plugins.plugins['vault-librarian']?.controller)`) ===
				'true',
			'the plugin to load',
		);
		obsidian(
			`${restore('language', shared.language)}; ${restore('EmulateMobile', shared.mobile)}; 'ok'`,
		);
		obsidian(
			`window.__demoOut = '${posix(OUT)}'; (0, eval)(require('fs').readFileSync('${posix(join(HERE, 'capture.js'))}', 'utf8')); 'loaded'`,
		);
	}

	async function scene(name, options = {}) {
		console.log(`scene ${name} ${JSON.stringify(options)}`);
		obsidian(`__demo.start('${name}', ${JSON.stringify(options)})`);
		let state;
		await until(
			() => {
				state = JSON.parse(
					tryObsidian('JSON.stringify(__demo.state)') ?? '{"running":true}',
				);
				return !state.running;
			},
			`scene ${name}`,
			600000,
		);
		if (state.error) throw new Error(`${name}: ${state.error}`);
	}

	resetNotes();
	const pluginDir = join(VAULT, '.obsidian', 'plugins', 'vault-librarian');
	mkdirSync(pluginDir, { recursive: true });
	for (const file of ['main.js', 'manifest.json', 'styles.css'])
		copyFileSync(join(ROOT, file), join(pluginDir, file));
	for (const dir of ['sessions', 'snapshots'])
		rmSync(join(pluginDir, dir), { recursive: true, force: true });
	rmSync(OUT, { recursive: true, force: true });

	if (tryObsidian('app.vault.getName()') !== 'Work')
		obsidian(
			`window.electron.ipcRenderer.sendSync('vault-open', '${posix(VAULT)}', false)`,
			null,
		);
	await until(() => tryObsidian('app.vault.getName()') === 'Work', 'the demo vault');

	try {
		await reload();
		await scene('setup');
		await scene('tour', { record: true });
		resetNotes();
		await scene('tour');
		await scene('web');
		await scene('context');
		await scene('settings');
		await reload({ mobile: true, width: 390, height: 844 });
		await scene('mobile', { record: true });
		await scene('mobile');
	} finally {
		await reload();
		await scene('finish');
		resetNotes();
	}
}

/** A recording as an MP4, and a stretch of it as a looping GIF `width` pixels wide. */
function media(name, { width, gifWidth, from, to, speed = 1 }) {
	const frames = join(OUT, 'frames', name);
	const video = join(MEDIA, `${name}.mp4`);
	run('ffmpeg', [
		...['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0'],
		...['-i', join(frames, 'frames.txt')],
		...['-vf', `fps=30,scale=${width}:-2:flags=lanczos,format=yuv420p`],
		...['-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart'],
		video,
	]);
	run('ffmpeg', [
		...['-y', '-loglevel', 'error', '-ss', String(from), '-to', String(to), '-i', video],
		...[
			'-vf',
			`setpts=PTS/${speed},fps=10,scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
		],
		...['-loop', '0', join(MEDIA, `${name}.gif`)],
	]);
}

if (process.argv[2] !== 'media') await record();

mkdirSync(MEDIA, { recursive: true });
const marks = (name) => JSON.parse(readFileSync(join(OUT, 'frames', name, 'marks.json'), 'utf8'));
const tour = marks('tour');
// The GIF is the first question, sped up so a slow answer still fits in a short loop.
media('tour', {
	width: 1440,
	gifWidth: 960,
	from: Math.max(0, tour.ask - 0.3),
	to: tour.answered + 2.5,
	speed: Math.max(1, (tour.answered - tour.ask) / 20),
});
const phone = marks('mobile');
media('mobile', {
	width: 584,
	gifWidth: 360,
	from: 0,
	to: phone.answered + 2.5,
	speed: Math.max(1, phone.answered / 20),
});
for (const file of readdirSync(join(OUT, 'shots')))
	run('magick', [join(OUT, 'shots', file), '-strip', join(MEDIA, file)]);
console.log(`Media written to ${MEDIA}`);
