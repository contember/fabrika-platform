import { type CloudflareRunnerJob, isCloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import { describe, expect, test } from 'bun:test'

const validJob: CloudflareRunnerJob = {
	runId: '0198c4a2-7b31-7e44-9a55-1f2e3d4c5b6a',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'abcdef1234567890abcdef1234567890abcdef12',
	env: 'prod',
	runnerKey: 'test-runner-key',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' },
}

describe('isCloudflareRunnerJob', () => {
	test('accepts a well-formed job', () => {
		expect(isCloudflareRunnerJob(validJob)).toBe(true)
	})

	test('non-dry jobs require a canonical full commit, while dry previews accept safe mutable refs', () => {
		for (const ref of ['main', 'refs/heads/main', 'refs/tags/v1', 'abc123', validJob.ref.toUpperCase(), 'a'.repeat(64)]) {
			expect(isCloudflareRunnerJob({ ...validJob, ref })).toBe(false)
			expect(isCloudflareRunnerJob({ ...validJob, ref, dryRun: false })).toBe(false)
		}
		for (const ref of ['main', 'refs/heads/main', 'refs/tags/v1', validJob.ref]) {
			expect(isCloudflareRunnerJob({ ...validJob, ref, dryRun: true })).toBe(true)
		}
		for (const ref of ['', '--upload-pack=x', 'main branch', 'main\n', `a${'b'.repeat(38)}\u0000`]) {
			expect(isCloudflareRunnerJob({ ...validJob, ref, dryRun: true })).toBe(false)
		}
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
		expect(isCloudflareRunnerJob({ ...validJob, managedEnvironment: { FABRIKA_RELEASE: 42 } })).toBe(false)
		expect(isCloudflareRunnerJob({ ...validJob, secrets: [] })).toBe(false)
	})
})
