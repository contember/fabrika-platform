// The kit decides as production does: every credential on every kind of path gets the same answer from the kit as
// from proxy-core's `Authorizer` over the endpoint table `contractProxyTable` compiles, with the same test IAM
// behind both.

import { TEST_ISSUER, testKit } from '@fabrika/app/testing'
import { compileEndpointTable } from '@fabrika/auth-core'
import { Authorizer, type Decision, type ResolvedApp } from '@fabrika/proxy-core'
import { type ContractProxyApp, contractProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { notesApp } from './fixtures/implement/app'

const kit = testKit(notesApp(new Map()))
const authorizer = new Authorizer({ iam: kit.iam, issuer: TEST_ISSUER })
const app: ContractProxyApp = {
	id: kit.appId,
	hosts: [new URL(kit.origin).host],
	upstream: 'app',
	scheme: 'https',
	...contractProxyTable(kit.artifact),
}
const resolved: ResolvedApp = { kind: 'endpoints', app, table: compileEndpointTable(app) }
const forwarded = (method: string, path: string, headers: Headers) => ({
	method,
	url: new URL(path, kit.origin),
	rawPath: path,
	headers,
	requestId: 'differential',
})

const person = kit.testCaller([{ action: 'notes.read' }])
const personKey = kit.testCaller([{ action: 'notes.read' }], { via: 'key', id: 'keyed-person' })
const machine = kit.testCaller([{ action: 'notes.write' }], { kind: 'machine' })
const link = kit.testCaller([{ action: 'notes.read' }], { kind: 'link' })

const CREDENTIALS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	none: {},
	session: { Cookie: person.cookie ?? '' },
	'stale session': { Cookie: '__Host-px_session=stale' },
	'human key': { Authorization: `Bearer ${personKey.key}` },
	'machine key': { Authorization: `Bearer ${machine.key}` },
	'link key': { Authorization: `Bearer ${link.key}` },
	'unknown key': { Authorization: 'Bearer px_unknown' },
	'not a key': { Authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.e30.sig' },
}

const PATHS: readonly (readonly [method: string, path: string, body: unknown])[] = [
	['POST', '/api/me', {}],
	['POST', '/machine/importNotes', { workspaceId: 'w1', titles: [] }],
	['GET', '/healthz', undefined],
	['GET', '/', undefined],
]

function headersFor(credential: Readonly<Record<string, string>>, body: unknown): Headers {
	const headers = new Headers({ 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin', ...credential })
	if (body !== undefined) {
		headers.set('Content-Type', 'application/json')
	}
	return headers
}

/** What the proxy itself answered, or `forwarded` when the response is the application's. */
async function answered(response: Response): Promise<string> {
	if (response.status === 302) {
		return 'login 302'
	}
	if ((response.headers.get('Content-Type') ?? '').startsWith('text/plain')) {
		return `deny ${response.status}`
	}
	const body: unknown = await response.clone().json().catch(() => null)
	const isLogin = response.status === 401 && typeof body === 'object' && body !== null && JSON.stringify(body).includes('"loginUrl"')
	return isLogin ? 'login 401' : 'forwarded'
}

function expected(decision: Decision): string {
	switch (decision.outcome) {
		case 'allow':
			return 'forwarded'
		case 'login':
			return `login ${decision.status}`
		case 'deny':
			return `deny ${decision.status}`
		case 'handoff':
			return 'handoff'
	}
}

describe('the kit and proxy-core decide alike', () => {
	for (const [method, path, body] of PATHS) {
		for (const [name, credential] of Object.entries(CREDENTIALS)) {
			test(`${name} on ${method} ${path}`, async () => {
				const headers = headersFor(credential, body)
				const decision = await authorizer.authorize(resolved, forwarded(method, path, headers))
				const response = await kit.fetch(path, { method, headers, body: body === undefined ? null : JSON.stringify(body) })
				expect(await answered(response)).toBe(expected(decision))
			})
		}
	}

	test("a person's key reaches a human mount as that person at both, and a machine mount at neither", async () => {
		const headers = headersFor(CREDENTIALS['human key'] ?? {}, {})
		expect(await authorizer.authorize(resolved, forwarded('POST', '/api/me', headers))).toMatchObject({ outcome: 'allow', subject: personKey.id })
		const response = await kit.fetch('/api/me', { method: 'POST', headers, body: '{}' })
		expect(await response.json()).toEqual({ result: { id: personKey.id, label: personKey.label } })
		const machineHeaders = headersFor(CREDENTIALS['human key'] ?? {}, { workspaceId: 'w1', titles: [] })
		expect(await authorizer.authorize(resolved, forwarded('POST', '/machine/importNotes', machineHeaders))).toMatchObject({
			outcome: 'deny',
			status: 403,
		})
		expect((await kit.fetch('/machine/importNotes', { method: 'POST', headers: machineHeaders, body: '{"workspaceId":"w1","titles":[]}' })).status)
			.toBe(
				403,
			)
	})

	test('an allowed session reaches the application as the subject the proxy verified', async () => {
		const headers = headersFor(CREDENTIALS['session'] ?? {}, {})
		const decision = await authorizer.authorize(resolved, forwarded('POST', '/api/me', headers))
		const response = await kit.fetch('/api/me', { method: 'POST', headers, body: '{}' })
		expect(decision).toMatchObject({ outcome: 'allow', gate: 'endpoint', subject: person.id })
		expect(await response.json()).toEqual({ result: { id: person.id, label: person.label } })
	})
})
