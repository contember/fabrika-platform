// A workload's key exchange at IAM's public token route: a decided refusal is `refused`, and every answer that is not
// IAM's decision — a 503 when its storage failed, a 429, a network failure — is `unavailable`, so a job reports
// `iam_unavailable`, never `unauthorized`, during an IAM outage.

import { TokenVerifier } from '@fabrika/jwks'
import { describe, expect, spyOn, test } from 'bun:test'
import { issuerWorkloadTokens, WorkloadCredential } from '../implement/workload'
import { APP_ID, ISSUER, keySource } from './fixtures/implement/harness'

function credential(answer: () => Promise<Response>): WorkloadCredential {
	return new WorkloadCredential({
		kind: 'job',
		name: 'nightly',
		key: 'px_harness_job_nightly',
		audience: APP_ID,
		source: issuerWorkloadTokens(ISSUER, answer),
		verifier: new TokenVerifier({ getJwks: () => keySource.getJwks(), issuer: ISSUER }),
	})
}

describe('the workload token exchange', () => {
	test.each([
		['a 503 IAM answers when its storage failed', () => Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 }))],
		['a 429 from the client bucket', () => Promise.resolve(Response.json({ error: 'rate_limited' }, { status: 429 }))],
		["an answer that is not IAM's outcome", () => Promise.resolve(Response.json({ token: 'x' }))],
		['a network failure', () => Promise.reject(new Error('connect ECONNREFUSED'))],
	])('%s is unavailable, not refused', async (_name, answer) => {
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect(await credential(answer).authority()).toEqual({ ok: false, reason: 'unavailable' })
		} finally {
			log.mockRestore()
		}
	})

	test('a decided invalid_key is refused', async () => {
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const refusal = () => Promise.resolve(Response.json({ ok: false, reason: 'invalid_key' }))
			expect(await credential(refusal).authority()).toEqual({ ok: false, reason: 'refused' })
		} finally {
			log.mockRestore()
		}
	})
})
