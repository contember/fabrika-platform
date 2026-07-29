import { type CloudflareRunnerJob, isCloudflareRunnerJob } from '@fabrika/provider-cloudflare'
import { describe, expect, test } from 'bun:test'

const validJob: CloudflareRunnerJob = {
	runId: 'run-1',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'main',
	env: 'prod',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' },
}

describe('isCloudflareRunnerJob', () => {
	test('accepts a well-formed job', () => {
		expect(isCloudflareRunnerJob(validJob)).toBe(true)
	})

	test('rejects non-objects and missing top-level fields', () => {
		expect(isCloudflareRunnerJob(null)).toBe(false)
		expect(isCloudflareRunnerJob('nope')).toBe(false)
		expect(isCloudflareRunnerJob({ ...validJob, runId: 42 })).toBe(false)
		expect(isCloudflareRunnerJob({ ...validJob, env: undefined })).toBe(false)
		const { credentials: _omit, ...noCreds } = validJob
		expect(isCloudflareRunnerJob(noCreds)).toBe(false)
	})

	test('rejects a job whose mandatory CF credentials are missing or empty', () => {
		// The whole point of the strengthened guard: never start a deploy that would authenticate blank.
		expect(isCloudflareRunnerJob({ ...validJob, credentials: {} })).toBe(false)
		expect(isCloudflareRunnerJob({ ...validJob, credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct' } })).toBe(false)
		expect(isCloudflareRunnerJob({ ...validJob, credentials: { CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: 'tok' } })).toBe(false)
		expect(isCloudflareRunnerJob({ ...validJob, credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: '' } })).toBe(false)
	})

	test('rejects malformed optional provider fields', () => {
		expect(isCloudflareRunnerJob({ ...validJob, stateNamespace: 42 })).toBe(false)
		expect(isCloudflareRunnerJob({ ...validJob, dryRun: 'yes' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...validJob, vars: { PUBLIC_URL: 42 } })).toBe(false)
		expect(isCloudflareRunnerJob({ ...validJob, secrets: [] })).toBe(false)
	})
})
