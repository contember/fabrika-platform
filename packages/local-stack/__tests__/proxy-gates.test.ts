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
import { OPERATIONS_PROXY_GATES } from '@fabrika/operations/gates'
import { parseProxyManifestJson } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { buildControlWorker } from '../../control/fabrika.config'
import { buildOperationsProxy } from '../../operations/fabrika.config'
import { localPlatformProxyManifest } from '../src/prepare'

/** The gates a production Cloudflare proxy Worker bakes into its own manifest. */
function productionGates(vars: Record<string, unknown> | undefined): unknown {
	const encoded = vars?.['FABRIKA_PROXY_MANIFEST_JSON']
	if (typeof encoded !== 'string') throw new Error('proxy Worker does not carry a manifest')
	const manifest = parseProxyManifestJson(encoded)
	const app = manifest?.apps[0]
	if (app === undefined) throw new Error('proxy Worker manifest declares no app')
	return app.gates
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
		expect(apps.get('operations')?.gates).toEqual(OPERATIONS_PROXY_GATES)
	})
})
