import type { ProviderDeployPlan, ProviderDeploySession, ProviderEnvelope, RuntimeProvider, RuntimeProviderRun } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { CANCELLED, deploy } from '../deploy'

const envelope = (payload: string): ProviderEnvelope => ({
	provider: 'harbor',
	version: 1,
	payload,
})

const makeRun = (options: { signal?: AbortSignal; dryRun?: boolean; logs?: string[] } = {}): RuntimeProviderRun => ({
	appId: 'api',
	env: 'production',
	cwd: '/workspace',
	secrets: {},
	vars: {},
	managedEnvironment: {},
	dryRun: options.dryRun ?? false,
	signal: options.signal ?? new AbortController().signal,
	events: {
		log: (line) => {
			options.logs?.push(line)
		},
		externalId: async () => {},
	},
	target: envelope('eu-west'),
	artifact: envelope('registry.example/api:v4'),
})

const plan = (...ids: string[]): ProviderDeployPlan => ({
	appId: 'api',
	env: 'production',
	steps: ids.map((id) => ({ id, kind: `harbor.${id}`, description: `Run ${id}` })),
})

const fakeProvider = (
	deployPlan: ProviderDeployPlan,
	execute: (stepId: string) => Promise<void>,
	opened?: RuntimeProviderRun[],
): RuntimeProvider => ({
	id: 'harbor',
	open: async (run): Promise<ProviderDeploySession> => {
		opened?.push(run)
		return { plan: deployPlan, execute }
	},
})

describe('deploy', () => {
	test('executes an explicitly supplied provider session in plan order', async () => {
		const opened: RuntimeProviderRun[] = []
		const executed: string[] = []
		const logs: string[] = []
		const provider = fakeProvider(
			plan('build', 'release'),
			async (stepId) => {
				executed.push(stepId)
			},
			opened,
		)

		const result = await deploy(provider, makeRun({ dryRun: true, logs }))

		expect(opened).toHaveLength(1)
		expect(opened[0]?.target.provider).toBe('harbor')
		expect(executed).toEqual(['build', 'release'])
		expect(result.status).toBe('succeeded')
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded'])
		expect(logs[0]).toContain('(dry-run)')
	})

	test('stops after the first failure and marks later steps skipped', async () => {
		const executed: string[] = []
		const provider = fakeProvider(plan('build', 'release', 'verify'), async (stepId) => {
			executed.push(stepId)
			if (stepId === 'release') {
				throw new Error('release rejected')
			}
		})

		const result = await deploy(provider, makeRun())

		expect(executed).toEqual(['build', 'release'])
		expect(result.status).toBe('failed')
		expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'failed', 'skipped'])
		expect(result.steps[1]?.error).toBe('release rejected')
	})

	test('owns cancellation transitions independently of provider implementation', async () => {
		const controller = new AbortController()
		const provider = fakeProvider(plan('release', 'verify'), async () => {
			controller.abort()
		})

		const result = await deploy(provider, makeRun({ signal: controller.signal }))

		expect(result.status).toBe('failed')
		expect(result.steps.map((step) => step.status)).toEqual(['failed', 'skipped'])
		expect(result.steps[0]?.error).toBe(CANCELLED)
	})

	test('rejects a provider plan for different run coordinates', async () => {
		const provider = fakeProvider({ appId: 'other', env: 'production', steps: [] }, async () => {})

		await expect(deploy(provider, makeRun())).rejects.toThrow(
			'deploy: provider "harbor" returned plan other/production, expected api/production',
		)
	})
})
