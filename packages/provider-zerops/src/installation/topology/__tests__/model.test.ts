// Zerops renders the installation model (ADR-0092). That the generated files are unchanged byte for byte is
// `@fabrika/platform-artifacts`' drift test (`topology.test.ts`, "every generated artifact is committed"); this file
// holds what that test cannot see: the data placement against the topology, and Control's Zerops variables against
// what the bring-up writes.

import { generateInstallationSecrets, type ModelVariable, PLATFORM_SERVICES, variableKey } from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import { fakeNamespaceProxySource } from '../../__tests__/fake-platform-source'
import { desiredServiceEnv, IAM_DATA_KEY_VARIABLE } from '../../deploy'
import { GENERATED_SECRET_KEYS, installationServiceEnv } from '../../install'
import { ZEROPS_CONTROL_VARIABLES, ZEROPS_DATA_PLACEMENT, zeropsInstallationModel } from '../model'
import { fabrikaZeropsYaml, PROXY_HEALTH_PORT, PROXY_PUBLIC_PORTS } from '../setups'
import { type PlatformTier, platformTopology } from '../topology'

const model = zeropsInstallationModel
const TIERS: readonly PlatformTier[] = ['standard', 'light']

describe('Zerops renders the installation model', () => {
	test('one setup per service of the model, and the proxy the one public one', () => {
		expect(fabrikaZeropsYaml.zerops.map((setup) => setup.setup).sort()).toEqual([...PLATFORM_SERVICES].sort())
		for (const tier of TIERS) {
			const services = platformTopology({ env: 'prod', tier, publicAccess: 'zerops-subdomain' }).target.services({ env: 'prod' })
			const runtimes = services.filter((service) => !service.type.startsWith('postgresql') && service.type !== 'object-storage')
			expect(runtimes.map((service) => service.hostname).sort()).toEqual([...PLATFORM_SERVICES].sort())
			expect(runtimes.filter((service) => service.enableSubdomainAccess === true).map((service) => service.hostname)).toEqual(
				PLATFORM_SERVICES.filter((name) => model.services[name].public),
			)
		}
	})

	test("the proxy's health listener is unpublished, and its first public listener is the model's", () => {
		expect(PROXY_HEALTH_PORT).toBe(model.services.proxy.health.port)
		expect(PROXY_PUBLIC_PORTS).not.toContain(PROXY_HEALTH_PORT)
		expect(PROXY_PUBLIC_PORTS[0]).toBe(model.services.proxy.ports.find((port) => port.name === 'http')?.port)
	})

	test("each store of the model is on a data service of the tier's topology, of its kind", () => {
		for (const tier of TIERS) {
			const services = new Map(
				platformTopology({ env: 'prod', tier }).target.services({ env: 'prod' }).map((service) => [service.hostname, service.type]),
			)
			const placement = ZEROPS_DATA_PLACEMENT[tier]
			for (const hostname of Object.values(placement.databases)) {
				expect({ tier, hostname, type: services.get(hostname)?.split(':')[0] }).toEqual({ tier, hostname, type: 'postgresql' })
			}
			for (const hostname of Object.values(placement.buckets)) {
				expect({ tier, hostname, type: services.get(hostname) }).toEqual({ tier, hostname, type: 'object-storage' })
			}
		}
	})

	test("the bring-up writes Control's Zerops variables, and the generated ones are the keys it counts as generated", () => {
		const env = installationServiceEnv({
			environment: 'stage',
			projectId: 'project-1',
			scheme: 'https',
			hosts: { iam: 'iam.example.com', control: 'console.example.com', operations: 'errors.example.com' },
			clientId: 'client-1',
			proxySource: fakeNamespaceProxySource(),
			secrets: generateInstallationSecrets(),
			zeropsAccessToken: 'minted',
			email: { kind: 'none' },
			authentication: { passwordEnabled: true },
			tier: 'light',
			apiBaseUrl: 'https://api.example.com',
		})
		const control = [...(env.get('control')?.keys() ?? [])]
		const own = ZEROPS_CONTROL_VARIABLES.map(variableKey)
		expect(control.filter((key) => key.startsWith('FABRIKA_ZEROPS_')).sort()).toEqual([...own].sort())

		const generated = (variables: readonly ModelVariable[]): string[] => variables.filter((variable) => variable.kind === 'generated').map(variableKey)
		for (const service of PLATFORM_SERVICES) {
			const variables = [...model.services[service].environment, ...(service === 'control' ? ZEROPS_CONTROL_VARIABLES : [])]
			expect({ service, keys: generated(variables).sort() }).toEqual({ service, keys: [...(GENERATED_SECRET_KEYS.get(service) ?? [])].sort() })
		}
	})

	test("a deploy writes exactly Control's derived Zerops variables", () => {
		const env = desiredServiceEnv(
			'stage',
			'project-1',
			{ hosts: { iam: 'iam.example.com', control: 'console.example.com', operations: 'errors.example.com' }, scheme: 'https', zeropsSubdomain: false },
			fakeNamespaceProxySource(),
			undefined,
			'd'.repeat(64),
			'px_provisioning',
		)
		const written = [...(env.get('control')?.keys() ?? [])].filter((key) => key.startsWith('FABRIKA_ZEROPS_')).sort()
		expect(written).toEqual(ZEROPS_CONTROL_VARIABLES.filter((variable) => variable.kind === 'derived').map(variableKey).sort())
	})

	test("the one key a deploy may generate is the model's one secret an upgrade may make", () => {
		const minted = Object.entries(model.secrets).filter(([, secret]) => secret.upgrade === 'mint').map(([name]) => name)
		const variables = PLATFORM_SERVICES.flatMap((service) =>
			model.services[service].environment.flatMap((variable) =>
				variable.kind === 'generated' && variable.secret !== undefined && minted.includes(variable.secret) ? [`${service}:${variable.name}`] : []
			)
		)
		expect(variables).toEqual([`iam:${IAM_DATA_KEY_VARIABLE}`])
	})
})
