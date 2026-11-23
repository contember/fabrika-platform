/**
 * A suspended entry: its environment is offline, so every request to its hosts is a 503 and nothing else of the entry is
 * consulted. Caddy answers it itself (`@fabrika/proxy`'s `suspendedRoute`); the decision answers the same when asked,
 * which is what the Cloudflare Worker would see.
 */

import { AUTH_CALLBACK_PATH } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { PROXY_TOKEN_HEADER } from '../constants'
import { type ContractEntryPlacement, contractProxyEntry, parseProxyManifest } from '../manifest'
import { createVerifyService } from '../service'
import { anonymousRow, contractAppWith, endpointRow, FakeIam, HOST, ISSUER, verifyRequest } from './helpers'

const PUBLIC = anonymousRow({ id: 'health', kind: 'health', method: 'GET', path: '/health', admission: null })
const SPA = endpointRow({ id: 'web', kind: 'spa', method: 'GET', path: '/*', callers: ['human'], requirement: { kind: 'member' }, admission: null })
const SIBLING_HOST = 'other.example.com'

function serviceWith(suspended: boolean) {
	const iam = new FakeIam()
	const apps = [
		contractAppWith([PUBLIC, SPA], [], { id: 'notes@prod', ...(suspended ? { suspended: true } : {}) }),
		contractAppWith([PUBLIC, SPA], [], { id: 'notes@stage', hosts: [SIBLING_HOST] }),
	]
	return { iam, verify: createVerifyService({ manifest: { apps }, iam, issuer: ISSUER }) }
}

describe('the manifest', () => {
	test('reads `suspended: true` on an application entry and nothing else in its place', () => {
		const entry = contractAppWith([PUBLIC], [], { id: 'notes@prod', suspended: true })
		expect(parseProxyManifest({ apps: [entry] })?.apps[0]).toMatchObject({ suspended: true })
		expect(parseProxyManifest({ apps: [{ ...entry, suspended: false }] })).toBeNull()
		expect(parseProxyManifest({ apps: [{ ...entry, suspended: 'yes' }] })).toBeNull()
	})

	test('a producer writes the flag only for a suspended placement', () => {
		const { endpoints, reservedPrefixes, snapshot, csp } = contractAppWith([PUBLIC])
		const placement: ContractEntryPlacement = {
			id: 'notes@prod',
			hosts: [HOST],
			upstream: 'app:3000',
			scheme: 'https',
			table: { endpoints, reservedPrefixes, snapshot, csp },
		}
		expect(contractProxyEntry({ ...placement, suspended: true }).suspended).toBe(true)
		expect('suspended' in contractProxyEntry({ ...placement, suspended: false })).toBe(false)
		expect('suspended' in contractProxyEntry(placement)).toBe(false)
	})
})

describe('the decision', () => {
	test('an anonymous endpoint of a suspended entry is a 503, and IAM is never asked', async () => {
		const { iam, verify } = serviceWith(true)
		const response = await verify(verifyRequest({ app: 'notes@prod', path: '/health' }))
		expect(response.status).toBe(503)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		expect(await response.text()).toBe('unavailable')
		expect(iam.mintFromKeyCalls + iam.mintTokenCalls + iam.exchangeCalls).toBe(0)
	})

	test('a key, the sign-in callback and a navigation are all a 503', async () => {
		const { iam, verify } = serviceWith(true)
		expect((await verify(verifyRequest({ app: 'notes@prod', path: '/notes', bearer: 'px_a-key-the-entry-never-reads' }))).status).toBe(503)
		expect((await verify(verifyRequest({ app: 'notes@prod', path: `${AUTH_CALLBACK_PATH}?code=c&state=s` }))).status).toBe(503)
		const page = await verify(verifyRequest({ app: 'notes@prod', path: '/', headers: { 'Sec-Fetch-Mode': 'navigate' } }))
		expect(page.status).toBe(503)
		expect(page.headers.get('Content-Type')).toStartWith('text/html')
		expect(iam.mintFromKeyCalls + iam.mintTokenCalls + iam.exchangeCalls).toBe(0)
	})

	test('a sibling entry of the namespace keeps serving, and the same entry serves once resumed', async () => {
		const suspended = serviceWith(true)
		expect((await suspended.verify(verifyRequest({ app: 'notes@stage', host: SIBLING_HOST, path: '/health' }))).status).toBe(204)
		const resumed = serviceWith(false)
		expect((await resumed.verify(verifyRequest({ app: 'notes@prod', path: '/health' }))).status).toBe(204)
	})
})
