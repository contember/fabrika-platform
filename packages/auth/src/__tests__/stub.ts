import { PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import type {
	AuditInput,
	IamRpc,
	IssueJwtInput,
	IssueJwtResult,
	IssueKeyInput,
	IssueKeyResult,
	Jwks,
	ListPrincipalsInput,
	ListPrincipalsResult,
	MintFromKeyInput,
	MintFromKeyResult,
	MintTokenInput,
	MintTokenResult,
	RevokeKeyInput,
	RevokeKeyResult,
} from '@fabrika/auth-core'

/**
 * In-memory `IamRpc` stub for SDK tests — no network. Returns canned mint/issue/revoke/list
 * results and records every `audit` call so tests can assert the auto-attached fields.
 */
export class IamRpcStub implements IamRpc {
	readonly auditCalls: AuditInput[] = []
	readonly revokeKeyInputs: RevokeKeyInput[] = []
	readonly listPrincipalsInputs: ListPrincipalsInput[] = []
	readonly mintTokenInputs: MintTokenInput[] = []
	readonly mintFromKeyInputs: MintFromKeyInput[] = []
	readonly issueKeyInputs: IssueKeyInput[] = []
	readonly issueJwtInputs: IssueJwtInput[] = []
	/** How many times the key set was actually fetched — the JWKS cache's only observable. */
	jwksCalls = 0
	/** The served key set. Settable so a test can rotate a key in between two verifications. */
	jwks: Jwks
	/** When set, `getJwks` rejects — the "IAM could not be consulted" half of the three-state model. */
	jwksError: Error | undefined

	constructor(
		private readonly canned: {
			revokeKey?: RevokeKeyResult
			listPrincipals?: ListPrincipalsResult
			mintToken?: MintTokenResult
			mintFromKey?: MintFromKeyResult
			issueKey?: IssueKeyResult
			issueJwt?: IssueJwtResult
			jwks?: Jwks
		} = {},
	) {
		this.jwks = canned.jwks ?? { keys: [] }
	}

	mintToken(input: MintTokenInput): Promise<MintTokenResult> {
		this.mintTokenInputs.push(input)
		return Promise.resolve(this.canned.mintToken ?? { ok: false, reason: 'no_session' })
	}

	mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult> {
		this.mintFromKeyInputs.push(input)
		return Promise.resolve(this.canned.mintFromKey ?? { ok: false, reason: 'invalid_key' })
	}

	issueKey(input: IssueKeyInput): Promise<IssueKeyResult> {
		this.issueKeyInputs.push(input)
		return Promise.resolve(this.canned.issueKey ?? { ok: false, reason: 'not_allowed' })
	}

	issueJwt(input: IssueJwtInput): Promise<IssueJwtResult> {
		this.issueJwtInputs.push(input)
		return Promise.resolve(this.canned.issueJwt ?? { ok: false, reason: 'not_allowed' })
	}

	getJwks(): Promise<Jwks> {
		this.jwksCalls += 1
		return this.jwksError === undefined ? Promise.resolve(this.jwks) : Promise.reject(this.jwksError)
	}

	listPrincipals(input: ListPrincipalsInput): Promise<ListPrincipalsResult> {
		this.listPrincipalsInputs.push(input)
		return Promise.resolve(
			this.canned.listPrincipals ?? { ok: false, reason: 'not_allowed' },
		)
	}

	audit(event: AuditInput): Promise<void> {
		this.auditCalls.push(event)
		return Promise.resolve()
	}

	revokeKey(input: RevokeKeyInput): Promise<RevokeKeyResult> {
		this.revokeKeyInputs.push(input)
		return Promise.resolve(
			this.canned.revokeKey ?? { ok: false, reason: 'not_found' },
		)
	}
}

/**
 * Build a Request carrying a forwarded native credential + a cf-ray. `proxyToken` sets the header the
 * proxy injects; `bearer` sets an `Authorization: Bearer` header (a machine `px_` key / passthrough
 * JWT); `cookie` sets the `px_token` access cookie. `readCredentials` prefers them in that order.
 */
export function makeRequest(opts: {
	url?: string
	proxyToken?: string
	bearer?: string
	cookie?: string
	ray?: string
} = {}): Request {
	const headers = new Headers()
	if (opts.proxyToken !== undefined) {
		headers.set(PROXY_TOKEN_HEADER, opts.proxyToken)
	}
	if (opts.bearer !== undefined) {
		headers.set('Authorization', `Bearer ${opts.bearer}`)
	}
	if (opts.cookie !== undefined) {
		headers.set('Cookie', `__Host-px_token=${opts.cookie}; other=ignored`)
	}
	if (opts.ray !== undefined) {
		headers.set('cf-ray', opts.ray)
	}
	return new Request(opts.url ?? 'https://app.example.com/path', { headers })
}
