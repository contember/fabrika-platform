// The HTTP RPC transport — the layer that stands in for a service binding when there isn't one.
//
// Everything asserted here is transport behaviour, so the `IamRpc` under it is a recorder: what
// matters is that the shared secret is enforced BEFORE anything else happens, that a body becomes the
// exact input the contract declares (or a 400, never a half-typed object), and that a method's own
// `{ ok: false }` stays a 200 — because that is what the binding returns and a caller must not have
// to tell "denied" apart from "unreachable". The methods' behaviour is covered by index.test.ts.

import type {
	AuditInput,
	ExchangeAuthCodeInput,
	ExchangeAuthCodeResult,
	IamHandoffRpc,
	IamMembershipRpc,
	IamRpc,
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
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { prop } from '../json'
import {
	handleMintHttp,
	handleRpcHttp,
	isMintPath,
	isRpcPath,
	MINT_DELEGATION_PATH,
	MINT_EXCHANGE_PATH,
	MINT_KEY_PATH,
	MINT_SESSION_PATH,
} from '../rpc-http'

const KEY = 'rpc-test-key-0123456789abcdefghij'
const BASE = 'https://iam.test'

describe('RPC input normalization', () => {
	test('optional null fields disappear and nested grant extensions are stripped', async () => {
		const { rpc, response } = call('issueKey', {
			app: '',
			credential: null,
			requestId: '',
			service: null,
			principalId: null,
			label: null,
			expiresAt: 1,
			permissions: [{ action: '', extra: true }, { action: 'read', scope: null }, { action: 'read', scope: { type: '', value: '', extra: true } }],
			extra: true,
		})
		expect((await response).status).toBe(200)
		expect(rpc.calls).toEqual([{
			method: 'issueKey',
			input: {
				app: '',
				credential: null,
				requestId: '',
				permissions: [{ action: '' }, { action: 'read', scope: null }, { action: 'read', scope: { type: '', value: '' } }],
				expiresAt: 1,
			},
		}])
	})

	test.each([
		{ method: 'issueKey', body: { service: { label: 'secret', permissions: [1], scope: 1 } }, field: 'service' },
		{ method: 'issueKey', body: { service: { label: 'secret', permissions: [], scope: 1 } }, field: 'service.scope' },
		{ method: 'issueKey', body: { permissions: [{ action: 'read', scope: { type: 'team' } }], label: 1 }, field: 'permissions[].scope' },
		{ method: 'audit', body: { resourceId: 1 }, field: 'resourceId' },
	])('preserves first-error ordering for $method / $field', async ({ method, body, field }) => {
		const { rpc, response } = call(method, body)
		const result = await response
		expect(result.status).toBe(400)
		const decoded: unknown = await result.json()
		expect(decoded).toEqual({ error: `invalid or missing field '${field}'` })
		expect(rpc.calls).toEqual([])
	})

	test('a downstream schema error is an internal fault, not invalid transport input', async () => {
		const rpc = recorder()
		rpc.mintToken = () => Promise.reject(new z.ZodError([]))
		const request = new Request(`${BASE}/rpc/mintToken`, {
			method: 'POST',
			headers: { authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ app: 'example', session: null, requestId: 'request' }),
		})
		const response = await handleRpcHttp(request, rpc, KEY)
		expect(response.status).toBe(500)
		const decoded: unknown = await response.json()
		expect(decoded).toEqual({ error: 'internal error' })
	})
})

/** Records the last input each method received, and answers with a canned result. */
interface Recorder extends IamRpc, IamHandoffRpc, IamMembershipRpc {
	calls: { method: string; input: unknown }[]
}

/** Results a test wants to override; everything else keeps the canned success below. */
interface Canned {
	exchangeAuthCode?: ExchangeAuthCodeResult
}

function recorder(canned: Canned = {}): Recorder {
	const calls: { method: string; input: unknown }[] = []
	const note = (method: string, input: unknown): void => {
		calls.push({ method, input })
	}
	return {
		calls,
		inspectDeviceAuthorization: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
		approveDeviceAuthorization: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
		denyDeviceAuthorization: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
		listOwnDeviceAuthorizations: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
		mintToken(input: MintTokenInput): Promise<MintTokenResult> {
			note('mintToken', input)
			return Promise.resolve({ ok: true, token: 'px_token', expiresAt: 42 })
		},
		mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult> {
			note('mintFromKey', input)
			return Promise.resolve({ ok: false, reason: 'invalid_key' })
		},
		exchangeAuthCode(input: ExchangeAuthCodeInput): Promise<ExchangeAuthCodeResult> {
			note('exchangeAuthCode', input)
			return Promise.resolve(
				canned.exchangeAuthCode ?? { ok: true, session: 'px_app_session', returnUrl: 'https://app.test/private', expiresAt: 99 },
			)
		},
		issueKey(input: IssueKeyInput): Promise<IssueKeyResult> {
			note('issueKey', input)
			return Promise.resolve({ ok: true, token: 'px_secret', id: 'cred-1' })
		},
		getJwks(): Promise<Jwks> {
			note('getJwks', undefined)
			return Promise.resolve({ keys: [] })
		},
		audit(event: AuditInput): Promise<void> {
			note('audit', event)
			return Promise.resolve()
		},
		listPrincipals(input: ListPrincipalsInput): Promise<ListPrincipalsResult> {
			note('listPrincipals', input)
			return Promise.resolve({ ok: true, principals: [] })
		},
		revokeKey(input: RevokeKeyInput): Promise<RevokeKeyResult> {
			note('revokeKey', input)
			return Promise.resolve({ ok: true, revoked: true })
		},
		requestDelegation(input) {
			note('requestDelegation', input)
			return Promise.resolve({ ok: true, grant: 'grant', expiresAt: 7 })
		},
		createScope(input) {
			note('createScope', input)
			return Promise.resolve({ ok: false, reason: 'invalid_delegation' })
		},
		assignMember(input) {
			note('assignMember', input)
			return Promise.resolve({ ok: true, assigned: { principalId: 'p', role: 'editor' } })
		},
		revokeMember(input) {
			note('revokeMember', input)
			return Promise.resolve({ ok: true })
		},
		listMembers(input) {
			note('listMembers', input)
			return Promise.resolve({ ok: true, members: [], invitations: [] })
		},
		findMember(input) {
			note('findMember', input)
			return Promise.resolve({ ok: true, member: { principalId: input.principalId, label: null, disabled: false } })
		},
		issueLink(input) {
			note('issueLink', input)
			return Promise.resolve({ ok: true, key: 'px_link', id: 'cred-link', expiresAt: 9 })
		},
		revokeLink(input) {
			note('revokeLink', input)
			return Promise.resolve({ ok: false, reason: 'not_found' })
		},
	}
}

describe('the membership methods over /rpc/*', () => {
	const caller = { app: 'notes@prod', credential: 'tok', requestId: 'req-1' }
	const scope = { type: 'workspace', value: 'w1' }

	test.each([
		{ method: 'requestDelegation', body: { ...caller, endpoint: 'api.invite' }, result: { ok: true, grant: 'grant', expiresAt: 7 } },
		{ method: 'createScope', body: { ...caller, delegation: 'g', dimension: 'workspace' }, result: { ok: false, reason: 'invalid_delegation' } },
		{
			method: 'assignMember',
			body: { ...caller, delegation: 'g', scope, role: 'editor', member: { email: 'a@b.test' } },
			result: { ok: true, assigned: { principalId: 'p', role: 'editor' } },
		},
		{ method: 'revokeMember', body: { ...caller, delegation: 'g', scope, member: { principalId: 'p' } }, result: { ok: true } },
		{ method: 'listMembers', body: { ...caller, scope }, result: { ok: true, members: [], invitations: [] } },
		{
			method: 'findMember',
			body: { ...caller, scope, principalId: 'p', action: 'notes.read' },
			result: { ok: true, member: { principalId: 'p', label: null, disabled: false } },
		},
		{
			method: 'issueLink',
			body: { ...caller, mount: 'shared', chain: [scope], days: 3 },
			result: { ok: true, key: 'px_link', id: 'cred-link', expiresAt: 9 },
		},
		{ method: 'revokeLink', body: { ...caller, id: 'cred-link' }, result: { ok: false, reason: 'not_found' } },
	])('$method decodes its input and answers its result as a 200', async ({ method, body, result }) => {
		const { rpc, response } = call(method, body)
		const answered = await response
		expect(answered.status).toBe(200)
		const decoded: unknown = await answered.json()
		expect(decoded).toEqual(result)
		expect(rpc.calls).toHaveLength(1)
	})

	test('a revoke target without a role reads as every membership role', async () => {
		const { rpc, response } = call('revokeMember', { ...caller, delegation: 'g', scope, member: { principalId: 'p' } })
		expect((await response).status).toBe(200)
		expect(rpc.calls[0]?.input).toEqual({ ...caller, delegation: 'g', scope, member: { principalId: 'p', role: null } })
	})

	test.each([
		{
			method: 'assignMember',
			body: { ...caller, delegation: 'g', scope, role: 'editor', member: { principalId: 'p', email: 'a@b.test' } },
			field: 'member',
		},
		{ method: 'issueLink', body: { ...caller, mount: 'shared', chain: [{ type: 'note' }], days: 3 }, field: 'chain' },
		{ method: 'findMember', body: { ...caller, scope, action: 'notes.read' }, field: 'principalId' },
		{ method: 'createScope', body: { ...caller, dimension: 'workspace' }, field: 'delegation' },
	])('$method refuses a malformed $field before it reaches IAM', async ({ method, body, field }) => {
		const { rpc, response } = call(method, body)
		const answered = await response
		expect(answered.status).toBe(400)
		const decoded: unknown = await answered.json()
		expect(decoded).toEqual({ error: `invalid or missing field '${field}'` })
		expect(rpc.calls).toEqual([])
	})
})

function call(method: string, body: unknown, options: { key?: string; bearer?: string | null; verb?: string } = {}): {
	rpc: Recorder
	response: Promise<Response>
} {
	const rpc = recorder()
	const headers = new Headers({ 'content-type': 'application/json' })
	const bearer = options.bearer === undefined ? KEY : options.bearer
	if (bearer !== null) {
		headers.set('Authorization', `Bearer ${bearer}`)
	}
	const request = new Request(`${BASE}/rpc/${method}`, { method: options.verb ?? 'POST', headers, body: JSON.stringify(body) })
	return { rpc, response: handleRpcHttp(request, rpc, options.key ?? KEY) }
}

describe('isRpcPath', () => {
	test('claims /rpc and /rpc/* and nothing else', () => {
		expect(isRpcPath('/rpc')).toBe(true)
		expect(isRpcPath('/rpc/mintToken')).toBe(true)
		expect(isRpcPath('/admin/principals')).toBe(false)
		expect(isRpcPath('/auth/login')).toBe(false)
		// The SPA must not be able to shadow it, and it must not swallow a lookalike path.
		expect(isRpcPath('/rpcs/mintToken')).toBe(false)
	})
})

describe('the shared-secret gate', () => {
	test('an unset key disables the surface entirely — 404, not 401', async () => {
		// The fail-closed default. A deploy that forgets the key loses RPC; it never publishes it.
		const { rpc, response } = call('getJwks', {}, { key: '' })
		const res = await response
		expect(res.status).toBe(404)
		expect(rpc.calls).toEqual([])
	})

	test('a missing, malformed or wrong bearer is 401 and never reaches the method', async () => {
		for (const bearer of [null, '', 'not-the-key', `${KEY}x`]) {
			const { rpc, response } = call('audit', { app: 'a' }, { bearer })
			const res = await response
			expect(res.status).toBe(401)
			expect(rpc.calls).toEqual([])
		}
	})

	test('no WWW-Authenticate challenge is advertised', async () => {
		const res = await call('getJwks', {}, { bearer: 'wrong' }).response
		expect(res.headers.get('www-authenticate')).toBeNull()
	})

	test('the gate runs before the body is parsed', async () => {
		// An unparseable body with a bad key is 401, not 400 — otherwise the surface answers questions
		// about itself to an unauthenticated caller.
		const request = new Request(`${BASE}/rpc/getJwks`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: 'not json' })
		expect((await handleRpcHttp(request, recorder(), KEY)).status).toBe(401)
	})

	test('only POST is accepted', async () => {
		const res = await call('getJwks', {}, { verb: 'GET' }).response
		expect(res.status).toBe(405)
		expect(res.headers.get('allow')).toBe('POST')
	})
})

describe('dispatch', () => {
	test('an unknown method is 404', async () => {
		const { rpc, response } = call('deleteEverything', {})
		expect((await response).status).toBe(404)
		expect(rpc.calls).toEqual([])
	})

	test('getJwks needs no input and returns the key set', async () => {
		const { rpc, response } = call('getJwks', {})
		const res = await response
		expect(res.status).toBe(200)
		const jwks: unknown = await res.json()
		expect(jwks).toEqual({ keys: [] })
		expect(rpc.calls.map((c) => c.method)).toEqual(['getJwks'])
	})

	test('audit answers 204 — it returns void over the binding, so there is nothing to encode', async () => {
		const { rpc, response } = call('audit', {
			credential: 'token',
			requestId: 'r1',
			principalId: null,
			principalLabel: 'anon',
			action: 'report.read',
			resourceType: 'report',
			resourceId: 'rep-1',
			diff: { a: [1, 2] },
			metadata: { via: 'http' },
		})
		expect((await response).status).toBe(204)
		expect(rpc.calls[0]?.input).toEqual({
			credential: 'token',
			requestId: 'r1',
			principalId: null,
			principalLabel: 'anon',
			action: 'report.read',
			resourceType: 'report',
			resourceId: 'rep-1',
			diff: { a: [1, 2] },
			metadata: { via: 'http' },
		})
	})

	test("a method's own denial is a 200 result, not an HTTP error", async () => {
		const { response } = call('mintFromKey', { app: 'opice', key: 'px_bad', requestId: 'r1' })
		const res = await response
		expect(res.status).toBe(200)
		const result: unknown = await res.json()
		expect(result).toEqual({ ok: false, reason: 'invalid_key' })
	})
})

describe('decoding', () => {
	test('mintToken carries an explicit null session through', async () => {
		const { rpc, response } = call('mintToken', { app: 'opice', session: null, requestId: 'r1' })
		expect((await response).status).toBe(200)
		expect(rpc.calls[0]?.input).toEqual({ app: 'opice', session: null, requestId: 'r1' })
	})

	test('issueKey reconstructs the full input, grants and scopes included', async () => {
		const { rpc, response } = call('issueKey', {
			app: 'opice',
			credential: 'px_caller',
			requestId: 'r1',
			label: 'ci key',
			expiresAt: 1799999999,
			permissions: [{ action: 'report.read', scope: { type: 'team', value: 'acme' } }, { action: 'report.export', scope: null }],
			service: { label: 'ci', permissions: ['report.read'], scope: { type: 'team', value: 'acme' } },
		})
		expect((await response).status).toBe(200)
		expect(rpc.calls[0]?.input).toEqual({
			app: 'opice',
			credential: 'px_caller',
			requestId: 'r1',
			label: 'ci key',
			expiresAt: 1799999999,
			permissions: [{ action: 'report.read', scope: { type: 'team', value: 'acme' } }, { action: 'report.export', scope: null }],
			service: { label: 'ci', permissions: ['report.read'], scope: { type: 'team', value: 'acme' } },
		})
	})

	test('optional fields are OMITTED rather than set to undefined', async () => {
		// `exactOptionalPropertyTypes`-shaped inputs: an absent field must not become `{ label: undefined }`,
		// or a `'label' in input` check downstream reads the opposite of what the caller sent.
		const { rpc, response } = call('issueKey', { app: 'opice', credential: null, requestId: 'r1', expiresAt: 1 })
		expect((await response).status).toBe(200)
		expect(rpc.calls[0]?.input).toEqual({ app: 'opice', credential: null, requestId: 'r1', expiresAt: 1 })
		expect(Object.keys(rpc.calls[0]?.input ?? {}).sort()).toEqual(['app', 'credential', 'expiresAt', 'requestId'])
	})

	test('a malformed body is 400 and never reaches the method', async () => {
		const cases: [string, unknown][] = [
			['app missing', { credential: null, requestId: 'r1', expiresAt: 1 }],
			['app not a string', { app: 7, credential: null, requestId: 'r1', expiresAt: 1 }],
			['credential absent (required, nullable)', { app: 'opice', requestId: 'r1', expiresAt: 1 }],
			['requestId missing', { app: 'opice', credential: null, expiresAt: 1 }],
			['expiresAt not a number', { app: 'opice', credential: null, requestId: 'r1', expiresAt: 'soon' }],
			['permissions not an array', { app: 'opice', credential: null, requestId: 'r1', permissions: 'all', expiresAt: 1 }],
			['a grant without an action', { app: 'opice', credential: null, requestId: 'r1', permissions: [{ scope: null }], expiresAt: 1 }],
			['a half-set scope', { app: 'opice', credential: null, requestId: 'r1', permissions: [{ action: 'x', scope: { type: 'team' } }], expiresAt: 1 }],
			['a service spec without permissions', { app: 'opice', credential: null, requestId: 'r1', service: { label: 'ci' }, expiresAt: 1 }],
			['a service spec with a non-string permission', {
				app: 'opice',
				credential: null,
				requestId: 'r1',
				service: { label: 'ci', permissions: [1] },
				expiresAt: 1,
			}],
			['expiresAt missing (required in every mode)', { app: 'opice', credential: null, requestId: 'r1', permissions: [{ action: 'x' }] }],
		]
		for (const [name, body] of cases) {
			const { rpc, response } = call('issueKey', body)
			const res = await response
			expect(`${name}: ${res.status}`).toBe(`${name}: 400`)
			expect(rpc.calls).toEqual([])
		}
	})

	test('a body that is not JSON at all is 400', async () => {
		const request = new Request(`${BASE}/rpc/getJwks`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: '{oops' })
		expect((await handleRpcHttp(request, recorder(), KEY)).status).toBe(400)
	})

	test('an error message names the field but never quotes its value', async () => {
		const res = await call('mintFromKey', { app: 'opice', key: 12345, requestId: 'r1' }).response
		const body: unknown = await res.json()
		const message = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : ''
		expect(message).toContain("'key'")
		expect(message).not.toContain('12345')
	})
})

describe('an empty body', () => {
	test('is fine for getJwks, which takes no input', async () => {
		// `POST /rpc/getJwks` with nothing attached is the natural call; it must not read as malformed.
		const request = new Request(`${BASE}/rpc/getJwks`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } })
		const rpc = recorder()
		expect((await handleRpcHttp(request, rpc, KEY)).status).toBe(200)
		expect(rpc.calls.map((c) => c.method)).toEqual(['getJwks'])
	})

	test('is a field-level 400 for a method that needs input', async () => {
		const request = new Request(`${BASE}/rpc/mintToken`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } })
		const rpc = recorder()
		const res = await handleRpcHttp(request, rpc, KEY)
		expect(res.status).toBe(400)
		const body: unknown = await res.json()
		expect(typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '').toContain("'app'")
		expect(rpc.calls).toEqual([])
	})
})

describe('the proxy mint surface', () => {
	// The contract is `packages/proxy/src/iam.ts` (`HttpIamGateway`). Deliberately NOT imported here:
	// coupling this suite to a package another agent is actively building would make its churn look
	// like a failure in mine. What is asserted instead is every shape that file reads — the three
	// paths, the POST verb, the request bodies, and "a decided outcome is always 200".
	const PROXY_KEY = 'proxy-test-key-0123456789abcdefghij'

	function mint(path: string, body: unknown, key: string | null = PROXY_KEY, canned: Canned = {}): { rpc: Recorder; response: Promise<Response> } {
		const rpc = recorder(canned)
		const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' })
		if (key !== null) {
			headers.set('authorization', `Bearer ${key}`)
		}
		const request = new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
		return { rpc, response: handleMintHttp(request, rpc, PROXY_KEY) }
	}

	test('claims exactly the four contract paths and nothing else under /auth', () => {
		expect(MINT_SESSION_PATH).toBe('/auth/mint/session')
		expect(MINT_KEY_PATH).toBe('/auth/mint/key')
		expect(MINT_EXCHANGE_PATH).toBe('/auth/mint/exchange')
		expect(MINT_DELEGATION_PATH).toBe('/auth/mint/delegation')
		expect(isMintPath(MINT_SESSION_PATH)).toBe(true)
		expect(isMintPath(MINT_KEY_PATH)).toBe(true)
		expect(isMintPath(MINT_EXCHANGE_PATH)).toBe(true)
		expect(isMintPath(MINT_DELEGATION_PATH)).toBe(true)
		// The public auth routes must keep reaching `handleAuth`, so nothing else here is claimed.
		expect(isMintPath('/auth/login')).toBe(false)
		expect(isMintPath('/auth/callback')).toBe(false)
		expect(isMintPath('/auth/mint')).toBe(false)
		expect(isMintPath('/auth/mint/session/extra')).toBe(false)
		expect(isMintPath('/auth/mint/exchange/extra')).toBe(false)
	})

	test('/auth/mint/session forwards {app, session, requestId} to mintToken', async () => {
		const { rpc, response } = mint(MINT_SESSION_PATH, { app: 'opice', session: 'sess-value', requestId: 'r1' })
		const res = await response
		expect(res.status).toBe(200)
		expect(rpc.calls).toEqual([{ method: 'mintToken', input: { app: 'opice', session: 'sess-value', requestId: 'r1' } }])
		const body: unknown = await res.json()
		// The gateway reads exactly these three fields off a success.
		expect(prop(body, 'ok')).toBe(true)
		expect(prop(body, 'token')).toBe('px_token')
		expect(prop(body, 'expiresAt')).toBe(42)
	})

	test('/auth/mint/key forwards {app, key, requestId} to mintFromKey', async () => {
		const { rpc, response } = mint(MINT_KEY_PATH, { app: 'opice', key: 'px_value', requestId: 'r1' })
		const res = await response
		expect(res.status).toBe(200)
		expect(rpc.calls).toEqual([{ method: 'mintFromKey', input: { app: 'opice', key: 'px_value', requestId: 'r1' } }])
	})

	test('/auth/mint/exchange forwards {app, code, verifier, requestId} to exchangeAuthCode', async () => {
		// ADR-0022's third endpoint. It was added to `isMintPath` and to the dispatch without ever being
		// named here, so a drift in either half would have shown up only as a 503 on the Zerops path.
		const { rpc, response } = mint(MINT_EXCHANGE_PATH, {
			app: 'opice',
			code: 'handoff-code-value',
			verifier: 'browser-verifier',
			requestId: 'r1',
		})
		const res = await response
		expect(res.status).toBe(200)
		expect(rpc.calls).toEqual([{
			method: 'exchangeAuthCode',
			input: { app: 'opice', code: 'handoff-code-value', verifier: 'browser-verifier', requestId: 'r1' },
		}])
		const body: unknown = await res.json()
		// The four fields `HttpIamGateway.exchangeAuthCode` reads off a success. It raises on any of them
		// missing or empty, which the proxy then answers as a 503.
		expect(prop(body, 'ok')).toBe(true)
		expect(prop(body, 'session')).toBe('px_app_session')
		expect(prop(body, 'returnUrl')).toBe('https://app.test/private')
		expect(prop(body, 'expiresAt')).toBe(99)
	})

	test('/auth/mint/delegation forwards {app, credential, requestId, endpoint} to requestDelegation', async () => {
		const input = { app: 'notes@prod', credential: 'token', requestId: 'r1', endpoint: 'api.workspaces.invite' }
		const { rpc, response } = mint(MINT_DELEGATION_PATH, input)
		const res = await response
		expect(res.status).toBe(200)
		expect(rpc.calls).toEqual([{ method: 'requestDelegation', input }])
		const body: unknown = await res.json()
		expect(prop(body, 'ok')).toBe(true)
		expect(prop(body, 'grant')).toBe('grant')
	})

	test('the delegation route is closed without the proxy key', async () => {
		const { rpc, response } = mint(MINT_DELEGATION_PATH, { app: 'notes@prod', credential: 't', requestId: 'r1', endpoint: 'e' }, null)
		expect((await response).status).toBe(401)
		expect(rpc.calls).toEqual([])
	})

	test('a REFUSED redemption is 200 with a reason, exactly like a refused mint', async () => {
		// A spent or expired code is the ordinary case — every successful sign-in leaves one behind. A
		// status code here would turn each of them into an `IamUnavailableError` and a 503.
		const { response } = mint(MINT_EXCHANGE_PATH, { app: 'opice', code: 'spent', verifier: 'browser-verifier', requestId: 'r1' }, PROXY_KEY, {
			exchangeAuthCode: { ok: false, reason: 'expired_code' },
		})
		const res = await response
		expect(res.status).toBe(200)
		const body: unknown = await res.json()
		expect(prop(body, 'ok')).toBe(false)
		expect(prop(body, 'reason')).toBe('expired_code')
	})

	test('an exchange missing its code is a 400 that never reaches the method', async () => {
		const { rpc, response } = mint(MINT_EXCHANGE_PATH, { app: 'opice', requestId: 'r1' })
		const res = await response
		expect(res.status).toBe(400)
		expect(rpc.calls).toEqual([])
		const body: unknown = await res.json()
		// Names the field, never the value — a code is a credential for as long as it lives.
		expect(typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '').toContain("'code'")
	})

	test('an exchange missing its verifier is a 400 that never reaches the method', async () => {
		const { rpc, response } = mint(MINT_EXCHANGE_PATH, { app: 'opice', code: 'code', requestId: 'r1' })
		const res = await response
		expect(res.status).toBe(400)
		expect(rpc.calls).toEqual([])
		const body: unknown = await res.json()
		expect(typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : '').toContain("'verifier'")
	})

	test('the exchange is closed without the proxy key, and disabled entirely without one configured', async () => {
		for (const key of [null, 'wrong-key-but-long-enough-0123456789']) {
			const { rpc, response } = mint(MINT_EXCHANGE_PATH, { app: 'opice', code: 'c', requestId: 'r1' }, key)
			expect((await response).status).toBe(401)
			expect(rpc.calls).toEqual([])
		}
		const request = new Request(`${BASE}${MINT_EXCHANGE_PATH}`, { method: 'POST', body: '{}' })
		expect((await handleMintHttp(request, recorder(), '')).status).toBe(404)
	})

	test('a DENIAL is 200 with a reason — the gateway must read "no", not "unavailable"', async () => {
		// The recorder's mintFromKey denies. A status code here would become `IamUnavailableError` and
		// then a 503, turning every wrong key into a platform incident.
		const res = await mint(MINT_KEY_PATH, { app: 'opice', key: 'px_bad', requestId: 'r1' }).response
		expect(res.status).toBe(200)
		const body: unknown = await res.json()
		expect(prop(body, 'ok')).toBe(false)
		expect(prop(body, 'reason')).toBe('invalid_key')
	})

	test('an explicit null session is carried through, not rejected', async () => {
		// `MintTokenInput.session` is nullable and `no_session` is a real, decided answer the proxy maps
		// to a login redirect. Decoding it as invalid would turn "not logged in" into an outage.
		const { rpc, response } = mint(MINT_SESSION_PATH, { app: 'opice', session: null, requestId: 'r1' })
		expect((await response).status).toBe(200)
		expect(rpc.calls[0]?.input).toEqual({ app: 'opice', session: null, requestId: 'r1' })
	})

	test('the surface is closed without its own key', async () => {
		for (const key of [null, 'wrong-key-but-long-enough-0123456789']) {
			const { rpc, response } = mint(MINT_SESSION_PATH, { app: 'opice', session: 'x', requestId: 'r1' }, key)
			expect((await response).status).toBe(401)
			expect(rpc.calls).toEqual([])
		}
	})

	test('an unset proxy key disables it (404) rather than opening it', async () => {
		const request = new Request(`${BASE}${MINT_SESSION_PATH}`, { method: 'POST', body: '{}' })
		expect((await handleMintHttp(request, recorder(), '')).status).toBe(404)
	})

	test('only POST, and a malformed body is a 400 that never reaches the method', async () => {
		const get = new Request(`${BASE}${MINT_SESSION_PATH}`, { method: 'GET', headers: { authorization: `Bearer ${PROXY_KEY}` } })
		expect((await handleMintHttp(get, recorder(), PROXY_KEY)).status).toBe(405)

		const { rpc, response } = mint(MINT_KEY_PATH, { app: 'opice', requestId: 'r1' })
		expect((await response).status).toBe(400)
		expect(rpc.calls).toEqual([])
	})
})
