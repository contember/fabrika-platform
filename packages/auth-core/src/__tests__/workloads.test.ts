import { describe, expect, test } from 'bun:test'
import type { ContractArtifact } from '../contract'
import { contractWorkloads, isOwnWorkloadName } from '../workloads'

const artifact: Pick<ContractArtifact, 'jobs' | 'mounts' | 'declared'> = {
	jobs: { nightly: { schedule: '0 3 * * *', actions: ['notes.purge', 'notes.read'], scope: { kind: 'app' }, timeoutMs: 900000, retries: 0 } },
	mounts: {
		api: { kind: 'rpc', prefix: '/api', callers: ['human'] },
		github: {
			kind: 'webhook',
			path: '/hooks/github',
			scheme: 'github-sha256',
			boundTo: { kind: 'dimension', dimension: 'repo' },
			timeoutMs: 10000,
			actions: ['repos.sync'],
		},
	},
	declared: {
		'api.notes.create': { sql: null, unscoped: {}, connect: [], issues: null },
		'api.stats.cta': { sql: null, unscoped: {}, connect: [], issues: null, actions: ['stats.click', 'stats.archive'] },
	},
}

describe('contractWorkloads', () => {
	test('lists each job, each webhook and each endpoint that declares workload actions, the actions sorted', () => {
		expect(contractWorkloads(artifact)).toEqual([
			{ kind: 'job', name: 'nightly', actions: ['notes.purge', 'notes.read'] },
			{ kind: 'webhook', name: 'github', actions: ['repos.sync'] },
			{ kind: 'public', name: 'api.stats.cta', actions: ['stats.archive', 'stats.click'] },
		])
	})

	test('an artifact of an older framework, with no declared section, has its jobs and webhooks only', () => {
		const { declared: _, ...older } = artifact
		expect(contractWorkloads(older).map((workload) => workload.kind)).toEqual(['job', 'webhook'])
	})
})

describe('isOwnWorkloadName', () => {
	test('a public procedure is named by its endpoint id; a job and a webhook by a name of the contract', () => {
		expect(isOwnWorkloadName('public', 'api.intake.register')).toBe(true)
		expect(isOwnWorkloadName('public', 'register')).toBe(false)
		expect(isOwnWorkloadName('job', 'nightly')).toBe(true)
		expect(isOwnWorkloadName('job', 'api.intake')).toBe(false)
		expect(isOwnWorkloadName('webhook', '9lives')).toBe(false)
	})
})
