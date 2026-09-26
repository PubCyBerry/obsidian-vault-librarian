import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretStore } from '../storage/secret-store';

/** The `obsidian://` action that brings the authorization code back into the app. */
export const OAUTH_PROTOCOL_ACTION = 'vault-librarian-oauth';
export const OAUTH_REDIRECT_URL = `obsidian://${OAUTH_PROTOCOL_ACTION}`;

export function oauthSecretId(serverId: string): string {
	return `vault-librarian-mcp-${serverId}-oauth`;
}

/** The secret of an OAuth client the user made in the server's console. */
export function clientSecretId(serverId: string): string {
	return `vault-librarian-mcp-${serverId}-client-secret`;
}

/** The OAuth `state` carries the server id so the redirect can be routed without a query string. */
export function serverIdFromState(state: string | undefined): string | null {
	const id = state?.split('.')[0];
	return id ? id : null;
}

export interface StoredOAuth {
	client?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	verifier?: string;
	/** When the tokens were made or refreshed, in ms: the newest copy of a sign-in wins. */
	at?: number;
	/** The device that made them, this one or the one whose shared sign-in it took (LIB-FEAT-289). */
	from?: string;
	/**
	 * Which sign-in the tokens belong to: made at a sign-in and kept through its refreshes, on
	 * every device that shares it. Devices follow only the copies of their own sign-in.
	 */
	grant?: string;
}

/** The same sign-in: a refresh can hand back tokens this device already holds. */
function sameTokens(a: OAuthTokens | undefined, b: OAuthTokens): boolean {
	return !!a && a.access_token === b.access_token && a.refresh_token === b.refresh_token;
}

export interface OAuthProviderDeps {
	serverId: string;
	secrets: SecretStore;
	/** Whether a browser may be opened right now (only after the user pressed Sign in). */
	interactive: () => boolean;
	open: (url: string) => void;
	/** Called with the authorization URL whenever the server asks for a sign-in. */
	onAuthorizationUrl: (url: string) => void;
	/** Called when the server rejected the saved tokens (invalid_grant) and they were dropped. */
	onTokensRejected?: () => void;
	/** Where the authorization comes back: a loopback address during a desktop sign-in. */
	redirectUrl?: () => string;
	/** Told each `state` sent out, so the loopback can recognize the answer to this sign-in. */
	onState?: (state: string) => void;
	/** A client made in the server's console; when set, no client is registered or stored. */
	configuredClient?: () => OAuthClientInformationMixed | undefined;
	/**
	 * Where the client, tokens and verifier are kept; this device's SecretStorage by default. A
	 * sign-in made for another device keeps them in memory, apart from this device's own.
	 */
	storage?: { read(): StoredOAuth; write(stored: StoredOAuth): void };
	/**
	 * A sign-in the user started waits in the browser. An authorization started meanwhile by
	 * anything else (a tool call, a reconnect) would replace its state and PKCE verifier, and the
	 * browser's answer would no longer be recognized, so none may start.
	 */
	busy?: () => boolean;
	/** This device's id, written with the tokens it makes. */
	deviceId?: () => string;
	/** Told of each new set of tokens this device made, to share it with the others. */
	onTokensSaved?: (stored: StoredOAuth) => void;
}

export const SIGN_IN_WAITING =
	'A sign-in to this server is waiting in the browser. Finish it, then try again.';

/**
 * OAuth 2.1 client state for one MCP server. Client registration, tokens and the PKCE verifier
 * live in SecretStorage on this device, like provider API keys; with a sync passphrase the
 * sign-in is also shared with the other devices (`SharedSignIns`, LIB-FEAT-289).
 */
export class ObsidianOAuthProvider implements OAuthClientProvider {
	constructor(private readonly deps: OAuthProviderDeps) {}

	get redirectUrl(): string {
		return this.deps.redirectUrl?.() ?? OAUTH_REDIRECT_URL;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: 'Vault Librarian',
			redirect_uris: [this.redirectUrl],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		};
	}

	state(): string {
		// The SDK asks for a state before it saves a new verifier, so refusing here keeps both.
		if (this.deps.busy?.()) throw new Error(SIGN_IN_WAITING);
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		const random = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		const state = `${this.deps.serverId}.${random}`;
		this.deps.onState?.(state);
		return state;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.deps.configuredClient?.() ?? this.read().client;
	}

	saveClientInformation(client: OAuthClientInformationMixed): void {
		this.write({ ...this.read(), client });
	}

	tokens(): OAuthTokens | undefined {
		return this.read().tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		const stored = this.read();
		// A refresh answered with a sign-in another device shared keeps it as it came.
		if (sameTokens(stored.tokens, tokens)) return;
		const next: StoredOAuth = {
			...stored,
			tokens,
			at: Date.now(),
			from: this.deps.deviceId?.(),
			// A refresh keeps the sign-in it refreshes; tokens where there were none start one.
			grant: (stored.tokens && stored.grant) || crypto.randomUUID(),
		};
		this.write(next);
		this.deps.onTokensSaved?.(next);
	}

	/** What this device holds for the server now. */
	current(): StoredOAuth {
		return this.read();
	}

	/** Holds another sign-in instead, such as the newer one another device shared. */
	replace(stored: StoredOAuth): void {
		this.write(stored);
	}

	redirectToAuthorization(url: URL): void {
		// Google hands out a refresh token only when asked for offline access, and again only on
		// a fresh consent; without one the sign-in would end with the hour-long access token.
		if (url.hostname === 'accounts.google.com') {
			url.searchParams.set('access_type', 'offline');
			url.searchParams.set('prompt', 'consent');
		}
		const href = url.toString();
		this.deps.onAuthorizationUrl(href);
		if (this.deps.interactive()) this.deps.open(href);
	}

	saveCodeVerifier(verifier: string): void {
		this.write({ ...this.read(), verifier });
	}

	codeVerifier(): string {
		const verifier = this.read().verifier;
		if (!verifier) throw new Error('No PKCE verifier saved. Start the sign-in again.');
		return verifier;
	}

	invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
		if (scope === 'all') {
			this.write({});
			return;
		}
		const stored = this.read();
		if (scope === 'client') stored.client = undefined;
		if (scope === 'tokens') {
			if (stored.tokens) this.deps.onTokensRejected?.();
			stored.tokens = undefined;
		}
		if (scope === 'verifier') stored.verifier = undefined;
		this.write(stored);
	}

	private read(): StoredOAuth {
		if (this.deps.storage) return this.deps.storage.read();
		const raw = this.deps.secrets.get(oauthSecretId(this.deps.serverId));
		if (!raw) return {};
		try {
			return JSON.parse(raw) as StoredOAuth;
		} catch {
			return {};
		}
	}

	private write(stored: StoredOAuth): void {
		if (this.deps.storage) this.deps.storage.write(stored);
		else this.deps.secrets.set(oauthSecretId(this.deps.serverId), JSON.stringify(stored));
	}
}
