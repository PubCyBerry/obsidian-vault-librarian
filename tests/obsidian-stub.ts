// Minimal in-memory stand-in for the `obsidian` module, enough for the units under test.

(globalThis as unknown as { window?: unknown }).window ??= globalThis;

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+|\/+$/g, '');
}

export function parseFrontMatterAliases(
	frontmatter: Record<string, unknown> | null | undefined,
): string[] | null {
	const raw = frontmatter?.aliases;
	if (Array.isArray(raw)) return raw.map(String);
	if (typeof raw === 'string') return [raw];
	return null;
}

export class TAbstractFile {
	path = '';
	name = '';
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	basename = '';
	extension = '';
	stat = { size: 0, mtime: 0, ctime: 0 };
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === '';
	}
}

export const Platform = { isMobile: false, isDesktop: true, isDesktopApp: false };

export const requestUrlMock: { impl: ((req: unknown) => Promise<unknown>) | null } = { impl: null };

export function requestUrl(req: unknown): Promise<unknown> {
	if (!requestUrlMock.impl) throw new Error('requestUrl is not mocked');
	return requestUrlMock.impl(req);
}

export class Notice {
	constructor(public message: string) {}
}

/** Flat `key: value` YAML plus one level of nested mappings; bare ": " in a value throws like js-yaml. */
export function parseYaml(yaml: string): unknown {
	const out: Record<string, unknown> = {};
	let nested: Record<string, unknown> | null = null;
	for (const raw of yaml.split(/\r?\n/)) {
		if (!raw.trim() || raw.trim().startsWith('#')) continue;
		const indented = /^\s+/.test(raw);
		const m = /^\s*([^:]+):\s*(.*)$/.exec(raw);
		if (!m) throw new Error(`bad line: ${raw}`);
		const key = m[1]!.trim();
		let value: unknown = m[2]!;
		if (typeof value === 'string' && value.includes(': ') && !/^["']/.test(value))
			throw new Error('mapping values are not allowed in this context');
		if (typeof value === 'string' && /^".*"$/.test(value)) value = JSON.parse(value);
		else if (typeof value === 'string' && /^'.*'$/.test(value)) value = value.slice(1, -1);
		if (indented && nested) nested[key] = value;
		else if (value === '') {
			nested = {};
			out[key] = nested;
		} else {
			nested = null;
			out[key] = value;
		}
	}
	return out;
}

/** Subsequence match; the score is minus the span, so tighter matches sort first descending. */
export function prepareFuzzySearch(query: string) {
	const q = query.toLowerCase();
	return (text: string): { score: number; matches: [number, number][] } | null => {
		const t = text.toLowerCase();
		let from = -1;
		let first = -1;
		for (const ch of q) {
			from = t.indexOf(ch, from + 1);
			if (from < 0) return null;
			if (first < 0) first = from;
		}
		return { score: -(from - first), matches: [] };
	};
}

/** Just enough of Obsidian's converter for the tests: links become [text](href), blocks new lines. */
export function htmlToMarkdown(el: { childNodes: ArrayLike<Node> } | string): string {
	if (typeof el === 'string') return el;
	const walk = (node: Node): string => {
		if (node.nodeType === 3) return node.textContent ?? '';
		const elem = node as Element;
		const inner = Array.from(elem.childNodes).map(walk).join('');
		if (elem.tagName === 'A') return `[${inner}](${elem.getAttribute('href')})`;
		if (/^(P|DIV|H\d|LI|MAIN|ARTICLE|SECTION|UL|OL)$/.test(elem.tagName)) return `${inner}\n`;
		return inner;
	};
	return Array.from(el.childNodes).map(walk).join('').replace(/\n+/g, '\n');
}

export class MarkdownView {}
export class Menu {}
export class Modal {}
export class ItemView {}
export class Plugin {}
export class PluginSettingTab {
	constructor(public app: unknown) {}
}
export class Setting {}
export class SettingGroup {}
export function requireApiVersion() {
	return true;
}
/** Base of a navigable settings page; the real one also gives rootEl and titlebarEl. */
export class SettingPage {
	title = '';
	containerEl: unknown = null;
}
export class FuzzySuggestModal {}
export class MarkdownRenderer {}
export function setIcon() {}
