/**
 * What the CLOUDFLARE proxy Workers bake into their own manifests is the same gate set the local
 * platform manifest fronts each service with.
 *
 * The local manifest no longer copies those sets — `prepare.ts` imports `CONTROL_PROXY_GATES` and
 * `OPERATIONS_PROXY_GATES` from the packages that own them, which is what removed the drift this file
 * used to exist for. What is left is the other half, and it is not tautological: the gates reach a
 * deployed proxy through `createCloudflareProxyWorker`, which serializes them into a var, and a
 * provider change could drop or reshape them without anything else noticing.
 *
 * It lives OUTSIDE `src/` because it must import `fabrika.config.ts`, which pulls in
 * `@fabrika/provider-cloudflare`: `tsconfig.json` includes `src/**` only, so oblaka's raw TypeScript
 * never reaches `bun run typecheck`.
 */

import { CONTROL_PROXY_GATES } from '@fabrika/control/gates'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { OPERATIONS_PROXY_GATES } from '@fabrika/operations/gates'
import { parseProxyManifestJson } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { buildControlWorker } from '../../control/fabrika.config'
import { buildOperationsProxy } from '../../operations/fabrika.config'
import { localPlatformProxyManifest } from '../src/prepare'

/** The single app a production Cloudflare proxy Worker bakes into its own manifest. */
function productionApp(vars: Record<string, unknown> | undefined): { id: string; gates: unknown } {
	const encoded = vars?.['FABRIKA_PROXY_MANIFEST_JSON']
	if (typeof encoded !== 'string') throw new Error('proxy Worker does not carry a manifest')
	const manifest = parseProxyManifestJson(encoded)
	const app = manifest?.apps[0]
	if (app === undefined) throw new Error('proxy Worker manifest declares no app')
	return app
}

/** The gates a production Cloudflare proxy Worker bakes into its own manifest. */
function productionGates(vars: Record<string, unknown> | undefined): unknown {
	return productionApp(vars).gates
}

describe('a deployed Cloudflare proxy Worker carries the declared gates', () => {
	test('control', () => {
		expect(productionGates(buildControlWorker({ env: 'local' }).options.vars)).toEqual(CONTROL_PROXY_GATES)
	})

	test('Operations', () => {
		expect(productionGates(buildOperationsProxy({ env: 'local' }).options.vars)).toEqual(OPERATIONS_PROXY_GATES)
	})

	test('and the local manifest fronts the same services with them', () => {
		const apps = new Map(localPlatformProxyManifest().apps.map((app) => [app.id, app]))
		expect(apps.get('vozka')?.gates).toEqual(CONTROL_PROXY_GATES)
		expect(apps.get(OPERATIONS_APP_ID)?.gates).toEqual(OPERATIONS_PROXY_GATES)
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
