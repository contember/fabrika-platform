// The platform proxy's manifest template, pinned against the installation it claims to describe.
//
// Generating it removed the second DEFINITION — the local composition calls the same generator now —
// but that only rules out a copy drifting from the gate modules. It does not rule out the template
// naming a service the topology never creates, dialing a port no setup publishes, or claiming a
// listener the proxy never opens. Those are the ways this document can be wrong while every other test
// in the repository passes, which is exactly how the hand-written live one was wrong for two days.

import { CONTROL_PROXY_GATES } from '@fabrika/control/gates'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { OPERATIONS_PROXY_GATES } from '@fabrika/operations/gates'
import { encodeProxyManifestJson, parseProxyManifestJson } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../artifacts'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '../generated/platform-proxy-manifest'
import {
	PLATFORM_CONSOLE_APP_ID,
	PLATFORM_IAM_APP_ID,
	PLATFORM_PROXY_APPS,
	platformProxyManifestArtifact,
	platformProxyManifestTemplate,
	resolvePlatformProxyManifest,
} from '../proxy-manifest'
import { fabrikaZeropsYaml, PROXY_HEALTH_PORT, PROXY_PUBLIC_PORTS } from '../setups'
import { compileTopology, platformTopology } from '../topology'

/** Every service hostname the platform project creates, in the tier named. */
const platformServices = (tier: 'standard' | 'light'): string[] =>
	compileTopology(platformTopology({ env: 'prod', tier }), 'prod').steady.document.services.map((service) => service.hostname)

/** The single HTTP port a setup publishes. `undefined` when the setup does not exist or opens none. */
const setupPort = (name: string): number | undefined => fabrikaZeropsYaml.zerops.find((setup) => setup.setup === name)?.run?.ports?.[0]?.port

/** What a `zerops-subdomain` installation's hostname looks like: one generated name per HTTP port. */
const subdomainHost = (port: number): string => `proxy-292c-${port}.prg1.zerops.app`

describe('the manifest template describes the installation the topology builds', () => {
	test('every fronted app names a service BOTH platform tiers create', () => {
		const standard = platformServices('standard')
		const light = platformServices('light')
		for (const app of PLATFORM_PROXY_APPS) {
			expect(standard).toContain(app.service)
			expect(light).toContain(app.service)
		}
	})

	test('every upstream dials the port that service publishes in `zerops.yaml`', () => {
		for (const app of PLATFORM_PROXY_APPS) {
			expect(app.upstream).toBe(`${app.service}:${setupPort(app.service) ?? 0}`)
		}
	})

	test('the proxy is not one of them — nothing may be fronted by the thing doing the fronting', () => {
		expect(PLATFORM_PROXY_APPS.map((app) => app.service)).not.toContain('proxy')
	})
})

describe('the public listeners', () => {
	test('each app answers on a distinct listener the proxy setup actually publishes', () => {
		const ports = PLATFORM_PROXY_APPS.map((app) => app.port)
		expect(new Set(ports).size).toBe(ports.length)
		for (const port of ports) {
			expect(PROXY_PUBLIC_PORTS).toContain(port)
		}
	})

	test('and never on the health listener, which is deliberately unpublished', () => {
		expect(PLATFORM_PROXY_APPS.map((app) => app.port)).not.toContain(PROXY_HEALTH_PORT)
	})

	test('the platform takes the first three, leaving the rest of the pool as application slots', () => {
		// On the subdomain path a port IS a hostname, so this assignment is an address: moving it moves
		// where IAM, the console and Operations answer. It should never change without a deliberate diff.
		expect(PLATFORM_PROXY_APPS.map((app) => app.port)).toEqual([8080, 8082, 8083])
		expect(PROXY_PUBLIC_PORTS.slice(PLATFORM_PROXY_APPS.length).length).toBeGreaterThan(0)
	})
})

describe('the gates come from the modules that own them', () => {
	test('the console carries `CONTROL_PROXY_GATES` and Operations `OPERATIONS_PROXY_GATES`', () => {
		const byId = new Map(PLATFORM_PROXY_APPS.map((app) => [app.id, app]))
		expect(byId.get(PLATFORM_CONSOLE_APP_ID)?.gates).toEqual(CONTROL_PROXY_GATES)
		expect(byId.get(OPERATIONS_APP_ID)?.gates).toEqual(OPERATIONS_PROXY_GATES)
	})

	test('IAM is a single `public` rule, because a gate in front of a login page is a login loop', () => {
		const iam = PLATFORM_PROXY_APPS.find((app) => app.id === PLATFORM_IAM_APP_ID)
		expect(iam?.gates.rules).toEqual([{ path: '/*', kind: 'public' }])
	})

	test('and the console is NOT `public` — the drift this item exists for', () => {
		const console_ = PLATFORM_PROXY_APPS.find((app) => app.id === PLATFORM_CONSOLE_APP_ID)
		expect(console_?.gates.rules.some((rule) => rule.path === '/*' && rule.kind === 'public')).toBe(false)
	})
})

describe('resolving the template', () => {
	const manifest = resolvePlatformProxyManifest(platformProxyManifestTemplate(), {
		scheme: 'https',
		placement: {
			iam: { hosts: [subdomainHost(8080)] },
			control: { hosts: [subdomainHost(8082)] },
			operations: { hosts: [subdomainHost(8083)] },
		},
	})

	test('names the three platform apps and nothing else', () => {
		expect(manifest.apps.map((app) => app.id)).toEqual([PLATFORM_IAM_APP_ID, PLATFORM_CONSOLE_APP_ID, OPERATIONS_APP_ID])
	})

	test('survives the wire format the proxy service reads it back through', () => {
		expect(parseProxyManifestJson(encodeProxyManifestJson(manifest))).toEqual(manifest)
	})

	test('keeps the installation upstreams unless the composition overrides one', () => {
		expect(manifest.apps.map((app) => app.upstream)).toEqual(['iam:3000', 'control:3000', 'operations:3000'])
		const overridden = resolvePlatformProxyManifest(platformProxyManifestTemplate(), {
			scheme: 'http',
			placement: {
				iam: { hosts: ['iam.test'], upstream: 'iam:18080' },
				control: { hosts: ['control.test'] },
				operations: { hosts: ['operations.test'] },
			},
		})
		expect(overridden.apps.map((app) => app.upstream)).toEqual(['iam:18080', 'control:3000', 'operations:3000'])
	})

	test('refuses a placement that would make two apps share a host', () => {
		expect(() =>
			resolvePlatformProxyManifest(platformProxyManifestTemplate(), {
				scheme: 'https',
				placement: {
					iam: { hosts: ['one.test'] },
					control: { hosts: ['one.test'] },
					operations: { hosts: ['two.test'] },
				},
			})
		).toThrow()
	})
})

describe('the committed artifact', () => {
	test('is what the declaration produces', () => {
		const artifact = platformProxyManifestArtifact()
		expect(readFileSync(resolve(REPO_ROOT, artifact.path), 'utf8')).toBe(artifact.content)
	})

	test('carries the template a deploy will read, gates included', () => {
		expect(PLATFORM_PROXY_MANIFEST_TEMPLATE).toEqual(platformProxyManifestTemplate())
	})
})
