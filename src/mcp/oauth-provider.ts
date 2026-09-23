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

/** The OAuth `state` carries the server id so the redirect can be routed without a query string. */
export function serverIdFromState(state: string | undefined): string | null {
	const id = state?.split('.')[0];
	return id ? id : null;
}

interface StoredOAuth {
	client?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	verifier?: string;
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
}

/**
 * OAuth 2.1 client state for one MCP server. Client registration, tokens and the PKCE verifier
 * live in SecretStorage on this device only, like provider API keys.
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
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		const random = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		const state = `${this.deps.serverId}.${random}`;
		this.deps.onState?.(state);
		return state;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.read().client;
	}

	saveClientInformation(client: OAuthClientInformationMixed): void {
		this.write({ ...this.read(), client });
	}

	tokens(): OAuthTokens | undefined {
		return this.read().tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.write({ ...this.read(), tokens });
	}

	redirectToAuthorization(url: URL): void {
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
			this.deps.secrets.clear(oauthSecretId(this.deps.serverId));
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
		const raw = this.deps.secrets.get(oauthSecretId(this.deps.serverId));
		if (!raw) return {};
		try {
			return JSON.parse(raw) as StoredOAuth;
		} catch {
			return {};
		}
	}

	private write(stored: StoredOAuth): void {
		this.deps.secrets.set(oauthSecretId(this.deps.serverId), JSON.stringify(stored));
	}
}
