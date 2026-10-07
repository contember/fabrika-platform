import { type CloudflareRunnerJob, cloudflareRunnerJobSchema } from '@fabrika/provider-cloudflare/runner'
import { describe, expect, test } from 'bun:test'

const validJob: CloudflareRunnerJob = {
	runId: '0198c4a2-7b31-7e44-9a55-1f2e3d4c5b6a',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'abcdef1234567890abcdef1234567890abcdef12',
	env: 'prod',
	runnerKey: 'test-runner-key',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' },
}

describe('cloudflareRunnerJobSchema', () => {
	test('accepts a well-formed job', () => {
		expect(cloudflareRunnerJobSchema.safeParse(validJob).success).toBe(true)
	})

	test('non-dry jobs require a canonical full commit, while dry previews accept safe mutable refs', () => {
		for (const ref of ['main', 'refs/heads/main', 'refs/tags/v1', 'abc123', validJob.ref.toUpperCase(), 'a'.repeat(64)]) {
			expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, ref }).success).toBe(false)
			expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, ref, dryRun: false }).success).toBe(false)
		}
		for (const ref of ['main', 'refs/heads/main', 'refs/tags/v1', validJob.ref]) {
			expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, ref, dryRun: true }).success).toBe(true)
		}
		for (const ref of ['', '--upload-pack=x', 'main branch', 'main\n', `a${'b'.repeat(38)}\u0000`]) {
			expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, ref, dryRun: true }).success).toBe(false)
		}
	})

	test('rejects non-objects and missing top-level fields', () => {
		expect(cloudflareRunnerJobSchema.safeParse(null).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse('nope').success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, runId: 42 }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, env: undefined }).success).toBe(false)
		const { credentials: _omit, ...noCreds } = validJob
		expect(cloudflareRunnerJobSchema.safeParse(noCreds).success).toBe(false)
	})

	test('rejects a job whose mandatory CF credentials are missing or empty', () => {
		// The whole point of the strengthened guard: never start a deploy that would authenticate blank.
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, credentials: {} }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct' } }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, credentials: { CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: 'tok' } }).success).toBe(
			false,
		)
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, credentials: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: '' } }).success).toBe(
			false,
		)
	})

	test('rejects malformed optional provider fields', () => {
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, stateNamespace: 42 }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, dryRun: 'yes' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, vars: { PUBLIC_URL: 42 } }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, managedEnvironment: { FABRIKA_RELEASE: 42 } }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...validJob, secrets: [] }).success).toBe(false)
	})
})
