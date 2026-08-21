import { describe, expect, test } from 'bun:test'
import {
	type ControlProvider,
	type ProviderDeployInput,
	type ProviderDeploymentNamespace,
	type ProviderEnvelope,
	type ProviderEnvironment,
	ProviderNamespaceError,
	type ProviderRegistration,
	type ProviderRegistrationInput,
} from '..'

const providerEnvelope = (provider: string, payload: string): ProviderEnvelope => ({
	provider,
	version: 1,
	payload,
})

const environment = (provider: string): ProviderEnvironment => ({
	appId: 'api',
	env: 'production',
	publicOrigin: 'https://api.example.test',
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
	managedEnvironment: {},
	dryRun: false,
	signal: new AbortController().signal,
	events: {
		log: () => {},
		externalId: async () => {},
		checkpoint: async () => {},
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
		expect(registration.environment.publicOrigin).toBe('https://api.example.test')

		const outcome = await harbor.deploy({ ...input, app: registration.app, environment: registration.environment })
		if (harbor.reconcile === undefined || harbor.cancel === undefined || harbor.secrets === undefined) {
			throw new Error('expected all optional harbor capabilities')
		}
		const reconciliation = await harbor.reconcile({
			runId: input.runId,
			externalId: 'harbor-run-9',
			environment: registration.environment,
			checkpoint: () => Promise.resolve(),
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

	test('supports provider-owned namespace lifecycle with durable checkpoints', async () => {
		const checkpoints: ProviderDeploymentNamespace[] = []
		const harbor: ControlProvider = {
			id: 'harbor',
			normalizeRegistration: normalizeHarborRegistration,
			deploy: async () => ({ state: 'succeeded' }),
			namespaces: {
				normalize: (namespace) => ({
					...namespace,
					target: providerEnvelope('harbor', `${namespace.target.payload}`.toLowerCase()),
				}),
				namespaceResourceClaims: () => ['dock:control'],
				registrationResourceClaims: (registration) => [`dock:${registration.app.id}`],
				provision: async (input) => {
					const namespace = {
						...input.namespace,
						target: providerEnvelope('harbor', 'dock-7'),
					}
					await input.events.checkpoint(namespace)
					return namespace
				},
				reconcile: async (input) => input.namespace,
			},
		}
		const namespace: ProviderDeploymentNamespace = {
			id: 'production',
			env: 'prod',
			exclusiveAppId: 'api',
			target: providerEnvelope('harbor', 'EU-WEST'),
		}
		if (harbor.namespaces === undefined) {
			throw new Error('expected namespace capabilities')
		}

		const normalized = harbor.namespaces.normalize(namespace)
		const provisioned = await harbor.namespaces.provision({
			namespace: normalized,
			signal: new AbortController().signal,
			events: {
				checkpoint: async (checkpoint) => {
					checkpoints.push(checkpoint)
				},
			},
		})

		expect(normalized.target.payload).toBe('eu-west')
		expect(harbor.namespaces.namespaceResourceClaims(normalized)).toEqual(['dock:control'])
		expect(harbor.namespaces.registrationResourceClaims(normalizeHarborRegistration({
			app: deployInput('harbor').app,
			environment: { ...environment('harbor'), namespace: normalized },
		}))).toEqual(['dock:api'])
		expect(provisioned.target.payload).toBe('dock-7')
		expect(checkpoints).toEqual([provisioned])
	})

	test('does not require namespaces from providers without placement lifecycle', () => {
		const harbor: ControlProvider = {
			id: 'harbor',
			normalizeRegistration: normalizeHarborRegistration,
			deploy: async () => ({ state: 'succeeded' }),
		}

		expect(harbor.namespaces).toBeUndefined()
		expect(
			harbor.normalizeRegistration({
				app: deployInput('harbor').app,
				environment: environment('harbor'),
			}).environment.namespace,
		).toBeUndefined()
	})
})

describe('ProviderNamespaceError', () => {
	test('carries a stable code and the upstream detail beside a catchable Error', () => {
		const error = new ProviderNamespaceError('zerops: project import failed (403)', 'insufficientPermissions', false, 'token may not create projects')

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('ProviderNamespaceError')
		expect(error.message).toBe('zerops: project import failed (403)')
		expect(error.code).toBe('insufficientPermissions')
		expect(error.retryable).toBe(false)
		expect(error.detail).toBe('token may not create projects')
	})

	test('leaves detail absent when the upstream said nothing beyond its code', () => {
		const error = new ProviderNamespaceError('namespace provisioning was cancelled', 'namespaceCancelled', true)

		expect(error.detail).toBeUndefined()
		expect(error.retryable).toBe(true)
	})
})
