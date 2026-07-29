import { describe, expect, test } from 'bun:test'
import type { ControlProvider, ProviderDeployInput, ProviderEnvelope, ProviderEnvironment, ProviderRegistration, ProviderRegistrationInput } from '..'

const providerEnvelope = (provider: string, payload: string): ProviderEnvelope => ({
	provider,
	version: 1,
	payload,
})

const environment = (provider: string): ProviderEnvironment => ({
	appId: 'api',
	env: 'production',
	target: providerEnvelope(provider, 'eu-west'),
	artifact: providerEnvelope(provider, 'registry.example/api:v4'),
})

const normalizeHarborRegistration = (input: ProviderRegistrationInput): ProviderRegistration => {
	if (input.app.id !== input.environment.appId) {
		throw new Error('environment belongs to another app')
	}
	if (input.environment.target.provider !== 'harbor' || input.environment.artifact.provider !== 'harbor') {
		throw new Error('registration belongs to another provider')
	}
	return {
		app: {
			...input.app,
			source: {
				...input.app.source,
				workerDir: input.app.source.workerDir ?? '.',
			},
		},
		environment: input.environment,
	}
}

const deployInput = (provider: string): ProviderDeployInput => ({
	runId: 'run-1',
	app: {
		id: 'api',
		source: {
			repoUrl: 'https://github.com/example/api.git',
			ref: 'refs/heads/main',
		},
	},
	environment: environment(provider),
	secrets: {},
	vars: {},
	dryRun: false,
	signal: new AbortController().signal,
	events: {
		log: () => {},
		externalId: async () => {},
	},
})

describe('ControlProvider', () => {
	test('supports a statically selected third provider without a registry', async () => {
		const deployed: string[] = []
		const cancelled: string[] = []
		const secrets = new Map<string, string>()
		const harbor: ControlProvider = {
			id: 'harbor',
			normalizeRegistration: normalizeHarborRegistration,
			deploy: async (input) => {
				deployed.push(input.runId)
				await input.events.externalId('harbor-run-9')
				return { state: 'succeeded', exitCode: 0 }
			},
			cancel: async (input) => {
				cancelled.push(input.externalId)
			},
			reconcile: async () => ({ state: 'running' }),
			secrets: {
				put: async (input) => {
					secrets.set(`${input.environment.appId}:${input.name}`, input.value)
					return { valueRef: `harbor:${input.environment.appId}:${input.name}` }
				},
				delete: async (input) => {
					secrets.delete(`${input.environment.appId}:${input.name}`)
				},
			},
		}
		const input = deployInput('harbor')
		const registration = harbor.normalizeRegistration({ app: input.app, environment: input.environment })

		const outcome = await harbor.deploy({ ...input, app: registration.app, environment: registration.environment })
		if (harbor.reconcile === undefined || harbor.cancel === undefined || harbor.secrets === undefined) {
			throw new Error('expected all optional harbor capabilities')
		}
		const reconciliation = await harbor.reconcile({
			runId: input.runId,
			externalId: 'harbor-run-9',
			environment: registration.environment,
		})
		await harbor.cancel({
			runId: input.runId,
			externalId: 'harbor-run-9',
			environment: registration.environment,
		})
		const secret = await harbor.secrets.put({
			environment: registration.environment,
			name: 'TOKEN',
			value: 'secret',
		})
		await harbor.secrets.delete({ environment: registration.environment, name: 'TOKEN' })

		expect(registration.app.source.workerDir).toBe('.')
		expect(outcome).toEqual({ state: 'succeeded', exitCode: 0 })
		expect(reconciliation.state).toBe('running')
		expect(secret.valueRef).toBe('harbor:api:TOKEN')
		expect(deployed).toEqual(['run-1'])
		expect(cancelled).toEqual(['harbor-run-9'])
		expect(secrets.size).toBe(0)
	})

	test('lets the selected provider reject foreign registration envelopes', () => {
		const harbor: ControlProvider = {
			id: 'harbor',
			normalizeRegistration: normalizeHarborRegistration,
			deploy: async () => ({ state: 'failed' }),
		}
		const input = deployInput('other')

		expect(() => harbor.normalizeRegistration({ app: input.app, environment: input.environment })).toThrow(
			'registration belongs to another provider',
		)
	})
})
