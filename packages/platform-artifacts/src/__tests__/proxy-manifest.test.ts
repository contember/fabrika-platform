// The platform proxy's manifest template, pinned against the installation it claims to describe.
//
// Generating it removed the second DEFINITION — the local composition calls the same generator now —
// but that only rules out a copy drifting from the service contracts. It does not rule out the template
// naming a service the topology never creates, dialing a port no setup publishes, or claiming a
// listener the proxy never opens. Those are the ways this document can be wrong while every other test
// in the repository passes, which is exactly how the hand-written live one was wrong for two days.

import type { MintFromKeyResult } from '@fabrika/auth-core'
import { controlMcpResource, controlMcpResourceMetadata, controlServiceContract, controlServiceDigest } from '@fabrika/control/service'
import { IAM_INSTALLATION_SERVICE_OPTIONS, iamServiceContract } from '@fabrika/iam/service'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { OPERATIONS_PUBLIC_SERVICE } from '@fabrika/operations/service'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE, platformServiceTableDigest } from '@fabrika/provider-zerops/installation'
import {
	compileTopology,
	fabrikaZeropsYaml,
	platformTopology,
	PROXY_HEALTH_PORT,
	PROXY_PUBLIC_PORTS,
} from '@fabrika/provider-zerops/installation/topology'
import { createVerifyService, PROXY_TOKEN_HEADER } from '@fabrika/proxy-core'
import { encodeProxyManifestJson, isApplicationEntry, parseProxyManifestJson, serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { APP, FakeIam, HOST, ISSUER, signToken, verifyRequest } from '../../../proxy-core/src/__tests__/helpers'
import {
	PLATFORM_CONSOLE_APP_ID,
	PLATFORM_IAM_APP_ID,
	PLATFORM_PROXY_APPS,
	type PlatformProxyComposition,
	platformProxyManifestArtifact,
	platformProxyManifestTemplate,
	resolvePlatformProxyManifest,
} from '../proxy-manifest'
import { REPO_ROOT } from '../render'

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

describe('the service tables come from the modules that own them', () => {
	const byId = new Map(PLATFORM_PROXY_APPS.map((app) => [app.id, app]))
	const rows = ({ endpoints, reservedPrefixes }: ReturnType<typeof controlServiceContract>) => ({ endpoints, reservedPrefixes })

	test('the console carries both of its tables, and Operations its `OPERATIONS_PUBLIC_SERVICE` table', () => {
		expect(byId.get(PLATFORM_CONSOLE_APP_ID)?.table).toEqual(rows(controlServiceContract({ mcp: true })))
		expect(byId.get(PLATFORM_CONSOLE_APP_ID)?.tableWithoutOAuth).toEqual(rows(controlServiceContract({ mcp: false })))
		expect(byId.get(OPERATIONS_APP_ID)?.table).toEqual({
			endpoints: OPERATIONS_PUBLIC_SERVICE.endpoints,
			reservedPrefixes: OPERATIONS_PUBLIC_SERVICE.reservedPrefixes,
		})
	})

	test('IAM carries its installation table, every row `protocol`, because a gate in front of a login page is a login loop', () => {
		const table = iamServiceContract(IAM_INSTALLATION_SERVICE_OPTIONS)
		const iam = byId.get(PLATFORM_IAM_APP_ID)?.table
		expect(iam).toEqual({ endpoints: table.endpoints, reservedPrefixes: table.reservedPrefixes })
		expect(new Set(iam?.endpoints.map((row) => row.kind))).toEqual(new Set(['protocol', 'health']))
	})

	test("IAM's published table serves every transport the installation's IAM process mounts", () => {
		const ids = byId.get(PLATFORM_IAM_APP_ID)?.table?.endpoints.map((row) => row.id) ?? []
		for (const id of ['mint-session', 'mint-key', 'mint-exchange', 'mint-delegation', 'membership', 'rpc', 'admin-rpc', 'health']) {
			expect(ids).toContain(id)
		}
	})

	test('and the console is NOT anonymous — the drift this item exists for', () => {
		const console_ = byId.get(PLATFORM_CONSOLE_APP_ID)?.table.endpoints.find((row) => row.path === '/*')
		expect(console_?.kind).toBe('service')
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

describe('the Operations entry, resolved, at the proxy', () => {
	const operations = resolvePlatformProxyManifest(platformProxyManifestTemplate(), {
		scheme: 'https',
		placement: { iam: { hosts: ['iam.test'] }, control: { hosts: ['console.test'] }, operations: { hosts: [HOST] } },
	}).apps.find((app) => app.id === OPERATIONS_APP_ID)
	if (operations === undefined) throw new Error('the template fronts no Operations app')
	const verifyWith = (mintFromKey?: MintFromKeyResult) =>
		createVerifyService({
			manifest: { apps: [{ ...operations, id: APP }] },
			iam: new FakeIam(mintFromKey === undefined ? {} : { mintFromKey }),
			issuer: ISSUER,
		})

	test('is an installation entry: its hop keeps Authorization, sets no proxy secret and no response policy', () => {
		expect('installation' in operations && operations.installation).toBe(true)
		expect(isApplicationEntry(operations)).toBe(false)
	})

	test('a path the public host does not serve is a proxy 403, with and without a machine key', async () => {
		const machine = verifyWith({ ok: true, token: await signToken({ type: 'service' }), expiresAt: Math.floor(Date.now() / 1000) + 300 })
		const anonymous = verifyWith()
		for (const path of ['/healthz', '/private/catalog/reconcile', '/private/releases/reconcile', '/api/rpc', '/api/undeclared-path']) {
			for (const method of ['GET', 'POST']) {
				expect((await anonymous(verifyRequest({ method, path }))).status).toBe(403)
				expect((await machine(verifyRequest({ method, path, bearer: 'px_machine' }))).status).toBe(403)
			}
		}
	})

	test('ingest and the upload reach Operations with no token minted, the upload with its bearer still on the request', async () => {
		const verify = verifyWith()
		for (
			const request of [
				verifyRequest({ method: 'POST', path: '/api/1/envelope/' }),
				verifyRequest({ method: 'POST', path: '/api/artifacts/source-maps/', bearer: 'release-upload-credential' }),
			]
		) {
			const response = await verify(request)
			expect(response.status).toBe(204)
			expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		}
	})
})

describe('MCP authoring, resolved', () => {
	const composition: PlatformProxyComposition = {
		scheme: 'https',
		placement: {
			iam: { hosts: [subdomainHost(8080)] },
			control: { hosts: [subdomainHost(8082)] },
			operations: { hosts: [subdomainHost(8083)] },
		},
	}
	const consoleOrigin = `https://${subdomainHost(8082)}`
	const consoleOf = (manifest: ReturnType<typeof resolvePlatformProxyManifest>) => manifest.apps.find((app) => app.id === PLATFORM_CONSOLE_APP_ID)
	const published = (mcp: boolean) => {
		const { endpoints, reservedPrefixes } = serviceProxyTable(controlServiceContract({ mcp }), { oauth: mcp })
		return { endpoints, reservedPrefixes }
	}

	test('enabled, the console publishes its MCP table and registers `controlMcpResource(origin)`', () => {
		const manifest = resolvePlatformProxyManifest(platformProxyManifestTemplate(), {
			...composition,
			authorizationServer: `https://${subdomainHost(8080)}`,
		})
		const console_ = consoleOf(manifest)
		expect({ endpoints: console_?.endpoints, reservedPrefixes: console_?.reservedPrefixes }).toEqual(published(true))
		expect(console_?.oauthResources).toEqual([{
			resource: controlMcpResource(consoleOrigin),
			resourceMetadata: controlMcpResourceMetadata(consoleOrigin),
			authorizationServers: [`https://${subdomainHost(8080)}`],
			scopesSupported: ['authoring'],
		}])
		expect(parseProxyManifestJson(encodeProxyManifestJson(manifest))).toEqual(manifest)
	})

	test('off, the console publishes its table without MCP and registers nothing', () => {
		const console_ = consoleOf(resolvePlatformProxyManifest(platformProxyManifestTemplate(), composition))
		expect({ endpoints: console_?.endpoints, reservedPrefixes: console_?.reservedPrefixes }).toEqual(published(false))
		expect(console_?.oauthResources).toBeUndefined()
	})

	test('the digest the deploy writes beside the console names the very table the proxy publishes, on and off', () => {
		const on = resolvePlatformProxyManifest(platformProxyManifestTemplate(), { ...composition, authorizationServer: `https://${subdomainHost(8080)}` })
		const off = resolvePlatformProxyManifest(platformProxyManifestTemplate(), composition)
		expect(platformServiceTableDigest(on, PLATFORM_CONSOLE_APP_ID)).toBe(controlServiceDigest({ mcp: true }))
		expect(platformServiceTableDigest(off, PLATFORM_CONSOLE_APP_ID)).toBe(controlServiceDigest({ mcp: false }))
	})

	test('only the console serves OAuth clients', () => {
		expect(PLATFORM_PROXY_APPS.filter((app) => app.oauthResource !== undefined).map((app) => app.id)).toEqual([PLATFORM_CONSOLE_APP_ID])
	})
})

describe('the committed artifact', () => {
	test('is what the declaration produces', () => {
		const artifact = platformProxyManifestArtifact()
		expect(readFileSync(resolve(REPO_ROOT, artifact.path), 'utf8')).toBe(artifact.content)
	})

	test('carries the template a deploy will read, tables included', () => {
		expect(PLATFORM_PROXY_MANIFEST_TEMPLATE).toEqual(platformProxyManifestTemplate())
	})
})
