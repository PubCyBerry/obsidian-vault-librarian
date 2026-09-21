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

export const Platform = { isMobile: false, isDesktop: true };

export const requestUrlMock: { impl: ((req: unknown) => Promise<unknown>) | null } = { impl: null };

export function requestUrl(req: unknown): Promise<unknown> {
	if (!requestUrlMock.impl) throw new Error('requestUrl is not mocked');
	return requestUrlMock.impl(req);
}

export class Notice {
	constructor(public message: string) {}
}

export class MarkdownView {}
export class Menu {}
export class Modal {}
export class ItemView {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class FuzzySuggestModal {}
export class MarkdownRenderer {}
export function setIcon() {}
