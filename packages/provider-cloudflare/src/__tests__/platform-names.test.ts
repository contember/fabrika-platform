import { describe, expect, test } from 'bun:test'
import { PLATFORM_RESOURCE_NAMES, platformNames, platformNameScheme, platformNamesOf } from '../platform-names'

describe('platform resource names', () => {
	test('an installation without the switch keeps the legacy names', () => {
		expect(platformNameScheme({})).toBe('legacy')
		expect(platformNameScheme({ FABRIKA_CLOUDFLARE_NAMES: '' })).toBe('legacy')
		expect(platformNameScheme({ FABRIKA_CLOUDFLARE_NAMES: 'legacy' })).toBe('legacy')
		expect(platformNameScheme({ FABRIKA_CLOUDFLARE_NAMES: 'fabrika' })).toBe('fabrika')
	})

	test('an unknown value is refused, never read as either scheme', () => {
		for (const value of ['Fabrika', 'fabrika ', 'new', 'true']) {
			expect(() => platformNameScheme({ FABRIKA_CLOUDFLARE_NAMES: value })).toThrow('FABRIKA_CLOUDFLARE_NAMES must be `fabrika` or `legacy`')
		}
	})

	// The legacy names are what every existing installation's resources are called: changing one orphans live data.
	test('the legacy names are exactly the ones existing installations were deployed with', () => {
		expect(platformNamesOf('legacy')).toEqual({
			controlWorker: 'vozka',
			controlProxy: 'vozka-proxy',
			controlDatabase: 'vozka',
			runLogs: 'vozka-run-logs',
			deployQueue: 'vozka-deploy',
			mailQueue: 'fabrika-mail',
			mailContent: 'fabrika-mail-content',
			runnerWorker: 'vozka-runner',
			runnerContainer: 'vozka-deploy-runner',
			iamWorker: 'propustka-worker',
			iamDatabase: 'propustka',
			operationsWorker: 'operations',
			operationsProxy: 'operations-proxy',
			operationsDatabase: 'operations',
			operationsPayloads: 'operations-payloads',
			operationsIngest: 'operations-ingest',
			operationsIngestDlq: 'operations-ingest-dlq',
			stateNamespaces: { propustka: 'propustka-state', vozka: 'vozka-state', 'vozka-runner': 'vozka-runner-state', operations: 'operations-state' },
		})
	})

	// The legacy mail relay was already named `fabrika-mail`: a new installation must not adopt an older one's.
	test('the fabrika names share no name with the legacy ones', () => {
		const { stateNamespaces: legacyState, ...legacy } = platformNamesOf('legacy')
		const { stateNamespaces: fabrikaState, ...fabrika } = platformNames({ FABRIKA_CLOUDFLARE_NAMES: 'fabrika' })
		const shared = Object.values(fabrika).filter((name) => Object.values(legacy).includes(name))
		expect(shared).toEqual([])
		expect(Object.values(fabrikaState).filter((name) => Object.values(legacyState).includes(name))).toEqual([])
		expect(Object.keys(fabrikaState).sort()).toEqual(Object.keys(legacyState).sort())
		// oblaka keys a component's state by env, and every component deploys in one env: each needs its own namespace.
		expect(new Set(Object.values(fabrikaState)).size).toBe(Object.values(fabrikaState).length)
	})

	test("an application is refused either scheme's names, whatever its installation uses", () => {
		for (const name of ['vozka', 'propustka-worker', 'propustka-state', 'fabrika-control', 'fabrika-iam', 'fabrika-iam-state', 'fabrika-run-logs']) {
			expect(PLATFORM_RESOURCE_NAMES.has(name)).toBe(true)
		}
		expect(PLATFORM_RESOURCE_NAMES.has('example-app')).toBe(false)
	})
})
