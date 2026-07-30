import { describe, expect, test } from 'bun:test'
import { createProvider, type JsonValue, type ProviderCodec, type ProviderDeployResult } from '..'

interface HarborTarget {
	region: string
}

interface HarborArtifact {
	image: string
	replicas: number
}

const objectProperty = (value: JsonValue, property: string): JsonValue => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('expected an object')
	}
	const propertyValue = value[property]
	if (propertyValue === undefined) {
		throw new Error(`missing ${property}`)
	}
	return propertyValue
}

const stringProperty = (value: JsonValue, property: string): string => {
	const propertyValue = objectProperty(value, property)
	if (typeof propertyValue !== 'string') {
		throw new Error(`${property} must be a string`)
	}
	return propertyValue
}

const numberProperty = (value: JsonValue, property: string): number => {
	const propertyValue = objectProperty(value, property)
	if (typeof propertyValue !== 'number') {
		throw new Error(`${property} must be a number`)
	}
	return propertyValue
}

const targetCodec: ProviderCodec<HarborTarget> = {
	version: 3,
	encode: (target) => ({ region: target.region }),
	decode: (payload) => ({ region: stringProperty(payload, 'region') }),
}

const artifactCodec: ProviderCodec<HarborArtifact> = {
	version: 7,
	encode: (artifact) => ({ image: artifact.image, replicas: artifact.replicas }),
	decode: (payload) => ({
		image: stringProperty(payload, 'image'),
		replicas: numberProperty(payload, 'replicas'),
	}),
}

describe('createProvider', () => {
	test('adapts a third provider to the opaque runtime without a central registry', async () => {
		const executed: string[] = []
		const externalIds: string[] = []
		const harbor = createProvider({
			id: 'harbor',
			target: targetCodec,
			artifact: artifactCodec,
			open: async (run) => {
				expect(run.target.region).toBe('eu-west')
				expect(run.artifact.image).toBe('registry.example/api:v4')
				expect(run.artifact.replicas).toBe(3)
				expect(run.managedEnvironment).toEqual({ FABRIKA_RELEASE: 'release-4' })
				await run.events.externalId(`harbor:${run.target.region}`)

				return {
					plan: {
						appId: run.appId,
						env: run.env,
						steps: [{ id: 'rollout', kind: 'harbor.rollout', description: `Roll out ${run.artifact.image}` }],
					},
					execute: async (stepId) => {
						executed.push(stepId)
					},
				}
			},
		})

		const target = harbor.encodeTarget({ region: 'eu-west' })
		const artifact = harbor.encodeArtifact({ image: 'registry.example/api:v4', replicas: 3 })
		const session = await harbor.runtime.open({
			appId: 'api',
			env: 'production',
			cwd: '/workspace',
			secrets: {},
			vars: {},
			managedEnvironment: { FABRIKA_RELEASE: 'release-4' },
			dryRun: false,
			signal: new AbortController().signal,
			events: {
				log: () => {},
				externalId: async (id) => {
					externalIds.push(id)
				},
			},
			target,
			artifact,
		})

		await session.execute('rollout')
		const firstStep = session.plan.steps[0]
		if (firstStep === undefined) {
			throw new Error('expected a rollout step')
		}
		const result: ProviderDeployResult = {
			appId: 'api',
			env: 'production',
			status: 'succeeded',
			plan: session.plan,
			steps: [{ spec: firstStep, status: 'succeeded' }],
		}

		expect(harbor.id).toBe('harbor')
		expect(target).toEqual({ provider: 'harbor', version: 3, payload: { region: 'eu-west' } })
		expect(artifact).toEqual({
			provider: 'harbor',
			version: 7,
			payload: { image: 'registry.example/api:v4', replicas: 3 },
		})
		expect(externalIds).toEqual(['harbor:eu-west'])
		expect(executed).toEqual(['rollout'])
		expect(result.status).toBe('succeeded')
	})

	test('rejects an envelope owned by another provider before decoding it', async () => {
		const harbor = createProvider({
			id: 'harbor',
			target: targetCodec,
			artifact: artifactCodec,
			open: async () => {
				throw new Error('must not open')
			},
		})

		const opening = harbor.runtime.open({
			appId: 'api',
			env: 'production',
			cwd: '/workspace',
			secrets: {},
			vars: {},
			managedEnvironment: {},
			dryRun: false,
			signal: new AbortController().signal,
			events: {
				log: () => {},
				externalId: async () => {},
			},
			target: { provider: 'other', version: 3, payload: { region: 'eu-west' } },
			artifact: harbor.encodeArtifact({ image: 'registry.example/api:v4', replicas: 3 }),
		})

		expect(opening).rejects.toThrow('target belongs to provider "other", expected "harbor"')
	})

	test('rejects unsupported target and artifact schema versions', async () => {
		const harbor = createProvider({
			id: 'harbor',
			target: targetCodec,
			artifact: artifactCodec,
			open: async () => {
				throw new Error('must not open')
			},
		})
		const baseRun = {
			appId: 'api',
			env: 'production',
			cwd: '/workspace',
			secrets: {},
			vars: {},
			managedEnvironment: {},
			dryRun: false,
			signal: new AbortController().signal,
			events: {
				log: () => {},
				externalId: async () => {},
			},
		}

		const targetVersion = harbor.runtime.open({
			...baseRun,
			target: { provider: 'harbor', version: 2, payload: { region: 'eu-west' } },
			artifact: harbor.encodeArtifact({ image: 'registry.example/api:v4', replicas: 3 }),
		})
		const artifactVersion = harbor.runtime.open({
			...baseRun,
			target: harbor.encodeTarget({ region: 'eu-west' }),
			artifact: { provider: 'harbor', version: 6, payload: { image: 'registry.example/api:v4', replicas: 3 } },
		})

		expect(targetVersion).rejects.toThrow('target schema version 2 is not supported by provider "harbor"')
		expect(artifactVersion).rejects.toThrow('artifact schema version 6 is not supported by provider "harbor"')
	})
})
