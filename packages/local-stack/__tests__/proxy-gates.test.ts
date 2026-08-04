/**
 * The local platform manifest must front control and Operations with the SAME gates their production
 * proxies do. `prepare.ts` cannot import those sets — they live in `fabrika.config.ts` files that pull
 * in `@fabrika/provider-cloudflare`, and oblaka's raw TypeScript does not compile under this package's
 * strict settings — so it copies them and this test proves the copies are still equal.
 *
 * It lives OUTSIDE `src/` for exactly that reason: `tsconfig.json` includes `src/**` only, so the
 * oblaka import graph never reaches `bun run typecheck`. The cheaper fix is for the two gate sets to be
 * exported from a module that does not depend on the Cloudflare provider; until then, this is the pin.
 */

import { parseProxyManifestJson } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { buildControlWorker } from '../../control/fabrika.config'
import { buildOperationsProxy } from '../../operations/fabrika.config'
import { localPlatformProxyManifest, localProductionGates } from '../src/prepare'

/** The gates a production Cloudflare proxy Worker bakes into its own manifest. */
function productionGates(vars: Record<string, unknown> | undefined): unknown {
	const encoded = vars?.['FABRIKA_PROXY_MANIFEST_JSON']
	if (typeof encoded !== 'string') throw new Error('proxy Worker does not carry a manifest')
	const manifest = parseProxyManifestJson(encoded)
	const app = manifest?.apps[0]
	if (app === undefined) throw new Error('proxy Worker manifest declares no app')
	return app.gates
}

describe('the local platform manifest carries the production gates', () => {
	test('control', () => {
		expect(localProductionGates.vozka).toEqual(productionGates(buildControlWorker({ env: 'local' }).options.vars))
	})

	test('Operations', () => {
		expect(localProductionGates.operations).toEqual(productionGates(buildOperationsProxy({ env: 'local' }).options.vars))
	})

	test('and the manifest actually uses them', () => {
		const apps = new Map(localPlatformProxyManifest().apps.map((app) => [app.id, app]))
		expect(apps.get('vozka')?.gates).toEqual(localProductionGates.vozka)
		expect(apps.get('operations')?.gates).toEqual(localProductionGates.operations)
	})
})
