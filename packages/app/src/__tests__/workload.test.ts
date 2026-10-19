// A workload's key exchange at IAM's public token route: a decided refusal is `refused`, and every answer that is not
// IAM's decision — a 503 when its storage failed, a 429, a network failure — is `unavailable`, so a job reports
// `iam_unavailable`, never `unauthorized`, during an IAM outage.

import { buildAccessClaims, type ContractArtifact, type OwnWorkloadKind, workloadKeyVariable } from '@fabrika/auth-core'
import { TokenVerifier } from '@fabrika/jwks'
import { describe, expect, spyOn, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { parseContractArtifact } from '../contract/artifact-schema'
import { issuerWorkloadTokens, WorkloadCredential, workloadCredentials, workloadSite } from '../implement/workload'
import { APP_ID, grant, ISSUER, keySource, sign } from './fixtures/implement/harness'

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

describe("a public procedure's credential", () => {
	const reach = { sql: null, unscoped: {}, connect: [], issues: null }
	const artifact: ContractArtifact = { ...notesArtifact, declared: { 'api.stats.cta': { ...reach, actions: ['stats.click'] } } }
	const verifier = new TokenVerifier({ getJwks: () => keySource.getJwks(), issuer: ISSUER })
	const variable = workloadKeyVariable('public', 'api.stats.cta')

	/** IAM's exchange answering every key with a token of `kind` naming `workload`. */
	const tokens = (kind: OwnWorkloadKind, workload: string) => ({
		async exchange() {
			const now = Math.floor(Date.now() / 1000)
			const claims = buildAccessClaims({
				iss: ISSUER,
				app: APP_ID,
				subject: 'principal',
				type: kind,
				workload,
				label: `${kind}:${workload}`,
				permissions: [grant('stats.click')],
				issuedAt: now,
				expiresAt: now + 300,
			})
			return { ok: true as const, token: await sign(claims), expiresAt: claims.exp }
		},
	})

	test('the artifact carries its actions under its endpoint id, and only there', () => {
		expect(parseContractArtifact(artifact).declared).toEqual(artifact.declared)
		expect(() => parseContractArtifact({ ...artifact, declared: { 'job:purgeDeleted': { ...reach, actions: ['stats.click'] } } })).toThrow(
			'workload actions belong to a public procedure',
		)
	})

	test('is found under its endpoint id, beside the job and webhook credentials, from the key under its own variable', () => {
		const framework = { [variable]: 'px_public_cta', FABRIKA_JOB_PURGE_DELETED_KEY: 'px_job', FABRIKA_WEBHOOK_GITHUB_KEY: 'px_webhook' }
		const problems: string[] = []
		const credentials = workloadCredentials({ artifact, framework, audience: APP_ID, source: tokens('public', 'api.stats.cta'), verifier }, problems)
		expect(problems).toEqual([])
		expect([...credentials.keys()].sort()).toEqual(['job:purgeDeleted', workloadSite('public', 'api.stats.cta'), 'webhook:github'].sort())
		workloadCredentials({ artifact, framework: {}, audience: APP_ID, source: undefined, verifier }, problems)
		expect(problems).toContain(`${variable} is not set to a px_ key; Control writes the credential of the public 'api.stats.cta' into every deploy`)
	})

	test('holds what IAM signs for its endpoint id, and refuses a token of another kind or another endpoint', async () => {
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const of = (source: ReturnType<typeof tokens>) =>
				new WorkloadCredential({ kind: 'public', name: 'api.stats.cta', key: 'px_public_cta', audience: APP_ID, source, verifier }).authority()
			expect(await of(tokens('public', 'api.stats.cta'))).toMatchObject({ ok: true, perms: [grant('stats.click')] })
			expect(await of(tokens('public', 'site.stats.cta'))).toEqual({ ok: false, reason: 'refused' })
			expect(await of(tokens('job', 'cta'))).toEqual({ ok: false, reason: 'refused' })
		} finally {
			log.mockRestore()
		}
	})
})
