import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreparedPlatformSource } from '../platform-source'
import type { PlatformUploadFetch } from '../platform-upload'

const interpolation = '${x_y} ${RUNTIME_FABRIKA_PROXY_MANIFEST_JSON} ${FABRIKA_PROXY_MANIFEST_JSON} $plain'
const contents = 'zerops:\n'
	+ ['iam', 'operations', 'proxy', 'control'].map((setup) =>
		`  - setup: ${setup}\n` + (setup === 'proxy' ? `    build:\n      envVariables:\n        PROBE: ${JSON.stringify(interpolation)}\n` : '')
	).join('')

/** An empty tar archive: the proxy's archive is this plus its manifest, so it must be a real one. */
const archivePath = join(await mkdtemp(join(tmpdir(), 'fabrika-fake-platform-source-')), 'source.tar.gz')
await Bun.write(archivePath, Bun.gzipSync(new Uint8Array(1024)))

export const fakePlatformSource = (): PreparedPlatformSource => ({
	commitSha: 'a'.repeat(40),
	descriptor: {
		path: 'zerops.yaml',
		sha256: new Bun.CryptoHasher('sha256').update(contents).digest('hex'),
		contents,
	},
	archivePath,
	dispose: async () => {},
})

export const fakeNamespaceProxySource = () => ({
	repository: { owner: 'contember', name: 'fabrika-platform' },
	commitSha: fakePlatformSource().commitSha,
	descriptor: fakePlatformSource().descriptor,
})

export const fakeSourceCollaborators = {
	prepareSource: async () => fakePlatformSource(),
	checkerPublished: async () => true,
	uploadFetch: (async (_url, init) => {
		await new Response(init.body).arrayBuffer()
		return new Response(null, { status: 200 })
	}) satisfies PlatformUploadFetch,
}
