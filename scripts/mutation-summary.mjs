// One Markdown report from Stryker's JSON reports: the score, the files with the most mutants
// that no test caught, and where the first of those mutants are. The nightly workflow puts it in
// the run summary; `npm run mutation:report` prints the same for a run made here.
//
//   node scripts/mutation-summary.mjs [folder with mutation.json files, default reports]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES_SHOWN = 15;
const FILES_DETAILED = 8;
const MUTANTS_PER_FILE = 8;

/** Every mutation.json under a folder: one for each folder of src in the nightly run. */
function reportsIn(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? reportsIn(join(dir, e.name))
			: e.name === 'mutation.json'
				? [join(dir, e.name)]
				: [],
	);
}

const files = [];
for (const path of reportsIn(process.argv[2] ?? 'reports')) {
	const report = JSON.parse(readFileSync(path, 'utf8'));
	for (const [name, file] of Object.entries(report.files)) {
		const count = (status) => file.mutants.filter((m) => m.status === status).length;
		const caught = count('Killed') + count('Timeout');
		const survived = file.mutants.filter((m) => m.status === 'Survived');
		const uncovered = count('NoCoverage');
		files.push({
			name,
			lines: file.source.split('\n'),
			caught,
			survived,
			uncovered,
			valid: caught + survived.length + uncovered,
			// A changed label or message is rarely worth a test; a changed condition often is.
			logic: survived.filter((m) => m.mutatorName !== 'StringLiteral'),
		});
	}
}
if (!files.length) {
	console.log('No mutation report found.');
	process.exit(0);
}

const percent = (caught, valid) => (valid ? `${((100 * caught) / valid).toFixed(1)}%` : 'n/a');
const sum = (pick) => files.reduce((total, f) => total + pick(f), 0);
const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
const link = (name, line) =>
	GITHUB_REPOSITORY
		? `[${name}:${line}](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${GITHUB_SHA}/${name}#L${line})`
		: `${name}:${line}`;
const code = (text) => `\`${text.replace(/\s+/g, ' ').replace(/`/g, "'").trim().slice(0, 70)}\``;

const out = [];
out.push(
	`## Mutation score: ${percent(
		sum((f) => f.caught),
		sum((f) => f.valid),
	)}`,
);
out.push('');
out.push(
	`${sum((f) => f.caught)} mutants caught, ${sum((f) => f.survived.length)} survived the tests that ran them, ${sum((f) => f.uncovered)} are in code no test runs.`,
);
out.push('');
out.push('### Files with the most survivors');
out.push('');
out.push('A survivor is a change to the code that every test still passed with.');
out.push('');
out.push('| File | Score | Caught | Survived | Of those, logic | No coverage |');
out.push('| --- | --- | --- | --- | --- | --- |');
const tested = files.filter((f) => f.caught + f.survived.length > 0);
tested.sort((a, b) => b.logic.length - a.logic.length);
for (const f of tested.slice(0, FILES_SHOWN))
	out.push(
		`| ${f.name} | ${percent(f.caught, f.valid)} | ${f.caught} | ${f.survived.length} | ${f.logic.length} | ${f.uncovered} |`,
	);
const untested = files.filter((f) => f.valid > 0 && f.caught + f.survived.length === 0);
if (untested.length) {
	out.push('');
	out.push(`No test runs any of: ${untested.map((f) => f.name).join(', ')}.`);
}
out.push('');
out.push('### Where to start');
out.push('');
out.push(
	'The first survivors in the files above, labels and messages left out. For each: write the test that tells the two versions apart, or delete the code if no test can.',
);
for (const f of tested.slice(0, FILES_DETAILED)) {
	if (!f.logic.length) continue;
	out.push('');
	out.push(`**${f.name}**`);
	out.push('');
	for (const m of f.logic.slice(0, MUTANTS_PER_FILE)) {
		const { start, end } = m.location;
		const line = f.lines[start.line - 1] ?? '';
		const original =
			start.line === end.line
				? line.slice(start.column - 1, end.column - 1)
				: `${line.slice(start.column - 1)} …`;
		out.push(
			`- ${link(f.name, start.line)} ${m.mutatorName}: ${code(original)} → ${code(m.replacement ?? '')}`,
		);
	}
	if (f.logic.length > MUTANTS_PER_FILE)
		out.push(`- and ${f.logic.length - MUTANTS_PER_FILE} more`);
}
out.push('');
out.push(
	'Every mutant, with the tests that ran it, is in the HTML report: `mutation.html` in each `mutation-report-<folder>` artifact of this run.',
);
console.log(out.join('\n'));
