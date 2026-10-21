import type { ContractArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { APP, FakeIam, HOST, ISSUER, signToken } from '../../../proxy-core/src/__tests__/helpers'
import { endpointProxy, type ProxyOutcome } from '../testing/proxy'

/** The notes contract with its GitHub webhook read as one whose verifier compares the sender's own `Authorization`. */
const artifact: ContractArtifact = {
	...notesArtifact,
	endpoints: notesArtifact.endpoints.map((row) => (row.id === 'github' ? { ...row, authorization: 'forward' } : row)),
}

async function proxied(iam: FakeIam, method: string, path: string, headers: Record<string, string>): Promise<ProxyOutcome> {
	const proxy = endpointProxy({ artifact, appId: APP, host: HOST, iam, issuer: ISSUER, delegations: null })
	return proxy({ method, url: `https://${HOST}${path}`, headers: new Headers({ 'Content-Type': 'application/json', ...headers }) })
}

function forwarded(outcome: ProxyOutcome): Extract<ProxyOutcome, { outcome: 'forward' }> {
	if (outcome.outcome !== 'forward') throw new Error(`expected a forward, got ${outcome.response.status}`)
	return outcome
}

describe("the test kit's proxy and the request's Authorization", () => {
	test("a credentialed row asserts the minted token as the application's Authorization, never the caller's key", async () => {
		const token = await signToken({ type: 'service', permissions: [{ action: 'notes.write', scope: null, source: 'grant' }] })
		const iam = new FakeIam({ mintFromKey: { ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 } })
		const outcome = forwarded(await proxied(iam, 'POST', '/machine/importNotes', { Authorization: 'Bearer px_key' }))
		expect(outcome.keepsAuthorization).toBe(false)
		expect(outcome.asserted.get('X-Fabrika-Token')).toBe(token)
		expect(outcome.asserted.get('Authorization')).toBe(`Bearer ${token}`)
	})

	test('a credentialed row reached by a session asserts no Authorization', async () => {
		const token = await signToken({ type: 'user' })
		const iam = new FakeIam({ mintToken: { ok: true, token, expiresAt: Math.floor(Date.now() / 1000) + 300 } })
		const outcome = forwarded(await proxied(iam, 'POST', '/api/me', { Cookie: '__Host-px_session=s1', 'Sec-Fetch-Site': 'same-origin' }))
		expect(outcome.asserted.get('X-Fabrika-Token')).toBe(token)
		expect(outcome.keepsAuthorization).toBe(false)
		expect(outcome.asserted.has('Authorization')).toBe(false)
	})

	test('an anonymous row drops the key it did not read', async () => {
		const outcome = forwarded(await proxied(new FakeIam(), 'GET', '/healthz', { Authorization: 'Bearer px_key' }))
		expect(outcome.keepsAuthorization).toBe(false)
		expect(outcome.asserted.has('Authorization')).toBe(false)
		expect(outcome.asserted.has('X-Fabrika-Token')).toBe(false)
	})

	test("a webhook the decision forwards keeps the sender's own Authorization", async () => {
		const outcome = forwarded(await proxied(new FakeIam(), 'POST', '/hooks/github/b1', { Authorization: 'Bearer provider-token' }))
		expect(outcome.keepsAuthorization).toBe(true)
		expect(outcome.asserted.has('Authorization')).toBe(false)
	})
})
