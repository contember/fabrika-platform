// The proxy Worker as a bundler substitutes its `define`: what wrangler does with the generated config's, through esbuild.

import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'oblaka-iac'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { FakeIam, HOST, ISSUER } from '../../../proxy-core/src/__tests__/helpers'
import { CLOUDFLARE_PROXY_WORKER_DIR, CLOUDFLARE_PROXY_WORKER_MAIN, createCloudflareProxyWorker, PROXY_MANIFEST_DEFINE } from '../proxy'

const out = await mkdtemp(join(tmpdir(), 'fabrika-proxy-bundle-'))

afterAll(async () => {
	await rm(out, { recursive: true, force: true })
})

interface BundledWorker {
	fetch(request: Request, env: Record<string, unknown>): Promise<Response>
}

const isBundledWorker = (value: unknown): value is BundledWorker =>
	typeof value === 'object' && value !== null && typeof Reflect.get(value, 'fetch') === 'function'

/** Bundle the proxy entrypoint with `define`, as wrangler does; the path of the bundle. */
const bundle = async (name: string, define: Record<string, string>): Promise<string> => {
	const built = await Bun.build({
		entrypoints: [join(CLOUDFLARE_PROXY_WORKER_DIR, CLOUDFLARE_PROXY_WORKER_MAIN)],
		outdir: join(out, name),
		target: 'bun',
		define,
	})
	const [output] = built.outputs
	if (!built.success || output === undefined) throw new Error('the proxy Worker did not bundle')
	return output.path
}

const load = async (path: string): Promise<BundledWorker> => {
	const loaded: unknown = await import(path)
	const worker: unknown = typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, 'default') : undefined
	if (!isBundledWorker(worker)) throw new Error('the bundle exports no Worker')
	return worker
}

const app = new Worker({ dir: '.', name: 'notes', main: './src/index.ts', compatibility_flags: [], bindings: {}, routes: [], workers_dev: false })
const proxy = createCloudflareProxyWorker({
	name: 'notes-proxy',
	app,
	appId: 'notes@prod',
	appHost: HOST,
	endpoints: contractProxyTable(notesArtifact),
})
const literal = proxy.options.define?.[PROXY_MANIFEST_DEFINE]
if (literal === undefined) throw new Error('the proxy Worker bakes no manifest')
// One build per file: under `bun test` a second `Bun.build` in the process misreads its sources. The unbaked bundle's
// fixed 503 is the handler's own with an empty manifest (`proxy-worker.test.ts`).
const bakedPath = await bundle('baked', { [PROXY_MANIFEST_DEFINE]: literal })

/** A Worker's env without any manifest: the deployed proxy has no `FABRIKA_PROXY_MANIFEST_JSON` variable. */
const env = (): Record<string, unknown> => ({
	IAM: new FakeIam(),
	FABRIKA_IAM_ISSUER: ISSUER,
	APP: { fetch: () => Promise.resolve(new Response('app')) },
})

describe('the bundled proxy Worker (backlog 177)', () => {
	test('serves the manifest baked into its bundle, with no manifest variable in its env', async () => {
		const baked = await load(bakedPath)
		// The decision ran on the baked table: an endpoint it does not list is refused, not answered with the fixed 503.
		const answer = await baked.fetch(new Request(`https://${HOST}/api/unknown`), env())
		expect(answer.status).toBe(403)
	})
})
