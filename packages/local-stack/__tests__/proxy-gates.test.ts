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
 * It lives OUTSIDE `src/` because it must import `fabrika.config.ts`, which pulls in
 * `@fabrika/provider-cloudflare`: `tsconfig.json` includes `src/**` only, so oblaka's raw TypeScript
 * never reaches `bun run typecheck`.
 */

import { controlServiceContract } from '@fabrika/control/service'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { OPERATIONS_PUBLIC_SERVICE } from '@fabrika/operations/service'
import { hasEndpointTable, parseProxyManifestJson, type ProxyApp, serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { buildControlWorker } from '../../control/fabrika.config'
import { buildOperationsProxy } from '../../operations/fabrika.config'
import { localPlatformProxyManifest } from '../src/prepare'

/** The single app a production Cloudflare proxy Worker bakes into its own manifest. */
function productionApp(vars: Record<string, unknown> | undefined): ProxyApp {
	const encoded = vars?.['FABRIKA_PROXY_MANIFEST_JSON']
	if (typeof encoded !== 'string') throw new Error('proxy Worker does not carry a manifest')
	const manifest = parseProxyManifestJson(encoded)
	const app = manifest?.apps[0]
	if (app === undefined) throw new Error('proxy Worker manifest declares no app')
	return app
}

/** The service table a production Cloudflare proxy Worker bakes into its own manifest. */
function productionAccess(vars: Record<string, unknown> | undefined): unknown {
	return accessOf(productionApp(vars))
}

function accessOf(app: ProxyApp | undefined): unknown {
	if (app === undefined || !hasEndpointTable(app)) return undefined
	return { installation: 'installation' in app, endpoints: app.endpoints, reservedPrefixes: app.reservedPrefixes }
}

const OPERATIONS_TABLE = serviceProxyTable(OPERATIONS_PUBLIC_SERVICE, { oauth: false })
// The Cloudflare console has no MCP route, so its proxy publishes the table without the OAuth row.
const CONTROL_TABLE = serviceProxyTable(controlServiceContract({ mcp: false }), { oauth: false })

describe('a deployed Cloudflare proxy Worker carries the declared service table', () => {
	test('control, as an installation entry', () => {
		expect(productionAccess(buildControlWorker({ env: 'local' }).options.vars)).toEqual(CONTROL_TABLE)
	})

	test('Operations, as an installation entry', () => {
		expect(productionAccess(buildOperationsProxy({ env: 'local' }).options.vars)).toEqual(OPERATIONS_TABLE)
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
		expect(productionApp(buildOperationsProxy({ env: 'local' }).options.vars).id).toBe(OPERATIONS_APP_ID)
		expect(localPlatformProxyManifest().apps.map((app) => app.id)).toContain(OPERATIONS_APP_ID)
	})
})
