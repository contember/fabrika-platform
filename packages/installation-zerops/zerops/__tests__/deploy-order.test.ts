// The deploy's own service list, pinned against the declarations that own those names.
//
// `PLATFORM_DEPLOY_ORDER` lives in `src/` so the published command never imports the dev-time
// generator, which means it restates four hostnames. This is the test that keeps the restatement
// honest: each one has to be a service BOTH platform tiers create AND a setup name the repository-root
// `zerops.yaml` declares, because `triggerPipeline` selects the setup by that name.

import { describe, expect, test } from 'bun:test'
import { PLATFORM_CONCURRENT_DEPLOY, PLATFORM_DEPLOY_ORDER, PLATFORM_PROXY_SERVICE, PLATFORM_SEQUENTIAL_DEPLOY } from '../../src/deploy'
import { platformProxyAppFor } from '../../src/proxy-manifest'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '../generated/platform-proxy-manifest'
import { PLATFORM_CONSOLE_APP_ID, PLATFORM_PROXY_APPS } from '../proxy-manifest'
import { fabrikaZeropsYaml } from '../setups'
import { compileTopology, platformTopology, PROXY_HOSTNAME } from '../topology'

const services = (tier: 'standard' | 'light'): string[] =>
	compileTopology(platformTopology({ env: 'prod', tier }), 'prod').steady.document.services.map((service) => service.hostname)

describe('the five services a platform deploy touches', () => {
	test('each is a service BOTH tiers create', () => {
		for (const hostname of PLATFORM_DEPLOY_ORDER) {
			expect(services('standard')).toContain(hostname)
			expect(services('light')).toContain(hostname)
		}
	})

	test('each is a setup the generated root `zerops.yaml` declares', () => {
		const setups = fabrikaZeropsYaml.zerops.map((setup) => setup.setup)
		expect([...setups].sort()).toEqual([...PLATFORM_DEPLOY_ORDER].sort())
	})

	test('is exactly the fronted apps, the private source service, and the proxy that fronts them', () => {
		expect(PLATFORM_PROXY_SERVICE).toBe(PROXY_HOSTNAME)
		expect(new Set(PLATFORM_DEPLOY_ORDER)).toEqual(new Set([...PLATFORM_PROXY_APPS.map((app) => app.service), 'source', PROXY_HOSTNAME]))
	})

	test('and the SEQUENCE puts the enforcement point ahead of the service whose gates it carries', () => {
		// Two stages, and only one of them is ordered. iam, operations and source order NOTHING against
		// each other — no boot-time call between them, no readiness gate that leaves the service, and no
		// variable one's deploy writes that another's build reads — so they build at once.
		expect(PLATFORM_CONCURRENT_DEPLOY).toEqual(['iam', 'operations', 'source'])
		for (const hostname of PLATFORM_CONCURRENT_DEPLOY) {
			expect(PLATFORM_DEPLOY_ORDER.indexOf(hostname)).toBeLessThan(PLATFORM_DEPLOY_ORDER.indexOf(PLATFORM_PROXY_SERVICE))
		}
		// ADR-0027: the application enforces nothing (ADR-0022), so a control plane at HEAD behind a proxy
		// still carrying the previous, more permissive manifest is an open `/api/*` for the deploy's length.
		expect(PLATFORM_SEQUENTIAL_DEPLOY).toEqual(['proxy', 'control'])
		expect(PLATFORM_DEPLOY_ORDER.indexOf('proxy')).toBeLessThan(PLATFORM_DEPLOY_ORDER.indexOf('control'))
		// Every service is in exactly one stage, so a service added to the deploy cannot fall out of both.
		expect([...PLATFORM_CONCURRENT_DEPLOY, ...PLATFORM_SEQUENTIAL_DEPLOY]).toEqual([...PLATFORM_DEPLOY_ORDER])
	})
})

test('the app the deploy reconciles into IAM is the console, read off the template rather than restated', () => {
	expect(platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control').id).toBe(PLATFORM_CONSOLE_APP_ID)
})
