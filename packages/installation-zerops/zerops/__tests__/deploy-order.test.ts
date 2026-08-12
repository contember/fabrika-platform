// The deploy's own service list, pinned against the declarations that own those names.
//
// `PLATFORM_DEPLOY_ORDER` lives in `src/` so the published command never imports the dev-time
// generator, which means it restates four hostnames. This is the test that keeps the restatement
// honest: each one has to be a service BOTH platform tiers create AND a setup name the repository-root
// `zerops.yaml` declares, because `triggerPipeline` selects the setup by that name.

import { describe, expect, test } from 'bun:test'
import { PLATFORM_DEPLOY_ORDER, PLATFORM_PROXY_SERVICE } from '../../src/deploy'
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

	test('and the ORDER puts the enforcement point ahead of the service whose gates it carries', () => {
		// ADR-0027: the application enforces nothing (ADR-0022), so a control plane at HEAD behind a proxy
		// still carrying the previous, more permissive manifest is an open `/api/*` for the deploy's length.
		expect(PLATFORM_DEPLOY_ORDER.indexOf('proxy')).toBeLessThan(PLATFORM_DEPLOY_ORDER.indexOf('control'))
		// …without giving up the dependency order control's private Operations dependency needs.
		expect(PLATFORM_DEPLOY_ORDER.indexOf('iam')).toBeLessThan(PLATFORM_DEPLOY_ORDER.indexOf('operations'))
		expect(PLATFORM_DEPLOY_ORDER.indexOf('operations')).toBeLessThan(PLATFORM_DEPLOY_ORDER.indexOf('control'))
		expect(PLATFORM_DEPLOY_ORDER.indexOf('source')).toBeLessThan(PLATFORM_DEPLOY_ORDER.indexOf('proxy'))
	})
})

test('the app the deploy reconciles into IAM is the console, read off the template rather than restated', () => {
	expect(platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control').id).toBe(PLATFORM_CONSOLE_APP_ID)
})
