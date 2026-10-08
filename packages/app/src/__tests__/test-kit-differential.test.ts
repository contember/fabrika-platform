// The kit decides as production does: every credential on every kind of path gets the same answer from the kit as
// from proxy-core's `Authorizer` over the gates `gatesFromContract` generates, with the same test IAM behind both.

import { gatesFromContract } from '@fabrika/app/contract'
import { TEST_ISSUER, testKit } from '@fabrika/app/testing'
import { Authorizer, compileGates, type Decision } from '@fabrika/proxy-core'
import { describe, expect, test } from 'bun:test'
import { notesApp } from './fixtures/implement/app'

const kit = testKit(notesApp(new Map()))
const authorizer = new Authorizer({ iam: kit.iam, issuer: TEST_ISSUER })
const resolved = {
	app: { id: kit.appId, hosts: [new URL(kit.origin).host], upstream: 'app', gates: gatesFromContract(kit.artifact), scheme: 'https' as const },
	gates: compileGates(gatesFromContract(kit.artifact)),
}

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
				const decision = await authorizer.authorize(resolved, { method, url: new URL(path, kit.origin), headers, requestId: 'differential' })
				const response = await kit.fetch(path, { method, headers, body: body === undefined ? null : JSON.stringify(body) })
				expect(await answered(response)).toBe(expected(decision))
			})
		}
	}

	test('a key on a human-only mount is a login at both', async () => {
		const headers = headersFor(CREDENTIALS['human key'] ?? {}, {})
		const decision = await authorizer.authorize(resolved, { method: 'POST', url: new URL('/api/me', kit.origin), headers, requestId: 'differential' })
		expect(decision).toMatchObject({ outcome: 'login', status: 401 })
		const response = await kit.fetch('/api/me', { method: 'POST', headers, body: '{}' })
		expect(response.status).toBe(401)
		expect(await response.json()).toMatchObject({ error: { type: 'auth' } })
	})

	test('an allowed session reaches the application as the subject the proxy verified', async () => {
		const headers = headersFor(CREDENTIALS['session'] ?? {}, {})
		const decision = await authorizer.authorize(resolved, { method: 'POST', url: new URL('/api/me', kit.origin), headers, requestId: 'differential' })
		const response = await kit.fetch('/api/me', { method: 'POST', headers, body: '{}' })
		expect(decision).toMatchObject({ outcome: 'allow', gate: 'human', subject: person.id })
		expect(await response.json()).toEqual({ result: { id: person.id, label: person.label } })
	})
})
