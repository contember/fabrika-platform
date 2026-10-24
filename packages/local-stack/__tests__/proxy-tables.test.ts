/**
 * What the CLOUDFLARE proxy Workers bake into their own manifests is the same service table the local
 * platform manifest fronts each service with.
 *
 * The local manifest no longer copies those tables — `prepare.ts` calls the installation's own generator,
 * which imports `controlServiceContract` and `OPERATIONS_PUBLIC_SERVICE` from the packages that own them,
 * and that is what removed the drift this file used to exist for. What is left is the other half, and
 * it is not tautological: the table reaches a deployed CLOUDFLARE proxy through
 * `createCloudflareProxyWorker`, which serializes it into a var, and a provider change could drop or
 * reshape it without anything else noticing.
 *
 * It also witnesses that no installation manifest carries a gate: every producer of one yields only
 * installation entries with an endpoint table, and the strict parser refuses a `gates` key.
 *
 * It lives OUTSIDE `src/` because it must import `fabrika.config.ts`, which pulls in
 * `@fabrika/provider-cloudflare`: `tsconfig.json` includes `src/**` only, so oblaka's raw TypeScript
 * never reaches `bun run typecheck`.
 */

import { controlServiceContract } from '@fabrika/control/service'
import type { PlatformProxyComposition } from '@fabrika/installation-init'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { OPERATIONS_PUBLIC_SERVICE } from '@fabrika/operations/service'
import { platformProxyManifestTemplate, resolvePlatformProxyManifest } from '@fabrika/platform-artifacts/proxy-manifest'
import { proxyManifestJson } from '@fabrika/provider-cloudflare'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '@fabrika/provider-zerops/installation'
import {
	encodeProxyManifestJson,
	isApplicationEntry,
	parseProxyManifestJson,
	type ProxyApp,
	type ProxyManifest,
	serviceProxyTable,
} from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildControlWorker } from '../../control/fabrika.config'
import { buildOperationsProxy } from '../../operations/fabrika.config'
import { localPlatformProxyManifest } from '../src/prepare'

type ProxyWorker = Parameters<typeof proxyManifestJson>[0]

/** The single app a production Cloudflare proxy Worker bakes into its own bundle. */
function productionApp(worker: ProxyWorker): ProxyApp {
	const encoded = proxyManifestJson(worker)
	if (encoded === null) throw new Error('proxy Worker does not carry a manifest')
	const manifest = parseProxyManifestJson(encoded)
	const app = manifest?.apps[0]
	if (app === undefined) throw new Error('proxy Worker manifest declares no app')
	return app
}

/** The service table a production Cloudflare proxy Worker bakes into its own bundle. */
function productionAccess(worker: ProxyWorker): unknown {
	return accessOf(productionApp(worker))
}

function accessOf(app: ProxyApp | undefined): unknown {
	if (app === undefined || isApplicationEntry(app)) return undefined
	return { installation: 'installation' in app, endpoints: app.endpoints, reservedPrefixes: app.reservedPrefixes }
}

const OPERATIONS_TABLE = serviceProxyTable(OPERATIONS_PUBLIC_SERVICE, { oauth: false })
// The Cloudflare console has no MCP route, so its proxy publishes the table without the OAuth row.
const CONTROL_TABLE = serviceProxyTable(controlServiceContract({ mcp: false }), { oauth: false })

describe('a deployed Cloudflare proxy Worker carries the declared service table', () => {
	test('control, as an installation entry', () => {
		expect(productionAccess(buildControlWorker({ env: 'local' }))).toEqual(CONTROL_TABLE)
	})

	test('Operations, as an installation entry', () => {
		expect(productionAccess(buildOperationsProxy({ env: 'local' }))).toEqual(OPERATIONS_TABLE)
	})

	test('and the local manifest fronts the same services with them', () => {
		const apps = new Map(localPlatformProxyManifest().apps.map((app) => [app.id, app]))
		expect(accessOf(apps.get('vozka'))).toEqual(CONTROL_TABLE)
		expect(accessOf(apps.get(OPERATIONS_APP_ID))).toEqual(OPERATIONS_TABLE)
	})
})

/**
 * The app id IS the audience: whatever a proxy mints for a host carries that host's app id as `aud`.
 * The Cloudflare Operations proxy used to say `vozka` here — a shape a shared manifest can never take,
 * because `parseProxyManifest` refuses a repeated id and control already holds that one.
 */
describe('both compositions name the Operations host by the same app', () => {
	test('the Cloudflare proxy Worker and the shared platform manifest agree', () => {
		expect(productionApp(buildOperationsProxy({ env: 'local' })).id).toBe(OPERATIONS_APP_ID)
		expect(localPlatformProxyManifest().apps.map((app) => app.id)).toContain(OPERATIONS_APP_ID)
	})
})

/** Every entry is an installation entry with a table, and the encoded document names no `gates` key anywhere. */
function expectNoGates(manifest: ProxyManifest): void {
	expect(manifest.apps.length).toBeGreaterThan(0)
	for (const app of manifest.apps) {
		expect(isApplicationEntry(app)).toBe(false)
		expect('installation' in app && app.installation).toBe(true)
		expect(app.endpoints.length).toBeGreaterThan(0)
	}
	const encoded = encodeProxyManifestJson(manifest)
	expect(encoded).not.toContain('"gates"')
	expect(parseProxyManifestJson(encoded)).toEqual(manifest)
}

describe("the installation's proxy manifest has no gates", () => {
	const composition: PlatformProxyComposition = {
		scheme: 'https',
		placement: {
			iam: { hosts: ['iam.example.test'] },
			control: { hosts: ['control.example.test'] },
			operations: { hosts: ['errors.example.test'] },
		},
	}

	test('the resolved platform manifest, with MCP authoring off and on', () => {
		expectNoGates(resolvePlatformProxyManifest(platformProxyManifestTemplate(), composition))
		expectNoGates(resolvePlatformProxyManifest(platformProxyManifestTemplate(), { ...composition, authorizationServer: 'https://iam.example.test' }))
	})

	test('the local platform manifest, with MCP authoring off and on', () => {
		expectNoGates(localPlatformProxyManifest())
		expectNoGates(
			localPlatformProxyManifest([{
				provider: 'claude',
				clientId: 'https://client.example/metadata',
				redirectUris: ['https://client.example/callback'],
			}]),
		)
	})

	test('the manifest each Cloudflare proxy Worker bakes into its bundle', () => {
		for (const worker of [buildControlWorker({ env: 'local' }), buildOperationsProxy({ env: 'local' })]) {
			const encoded = proxyManifestJson(worker)
			if (encoded === null) throw new Error('proxy Worker does not carry a manifest')
			const manifest = parseProxyManifestJson(encoded)
			if (manifest === null) throw new Error('the strict parser refuses a proxy Worker manifest')
			expectNoGates(manifest)
		}
	})

	test('the committed template, as generated', () => {
		expect(JSON.stringify(PLATFORM_PROXY_MANIFEST_TEMPLATE)).not.toContain('"gates"')
		const source = readFileSync(new URL('../../provider-zerops/src/installation/generated/platform-proxy-manifest.ts', import.meta.url), 'utf8')
		expect(source).not.toContain('gates')
	})
})
