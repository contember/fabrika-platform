import type { PreparedPlatformSource } from '../platform-source'
import type { PlatformUploadFetch } from '../platform-upload'

const interpolation = '${x_y} ${RUNTIME_FABRIKA_PROXY_MANIFEST_JSON} ${FABRIKA_PROXY_MANIFEST_JSON} $plain'
const contents = 'zerops:\n'
	+ ['iam', 'operations', 'proxy', 'control'].map((setup) =>
		`  - setup: ${setup}\n` + (setup === 'proxy' ? `    build:\n      envVariables:\n        PROBE: ${JSON.stringify(interpolation)}\n` : '')
	).join('')

export const fakePlatformSource = (): PreparedPlatformSource => ({
	commitSha: 'a'.repeat(40),
	descriptor: {
		path: 'zerops.yaml',
		sha256: new Bun.CryptoHasher('sha256').update(contents).digest('hex'),
		contents,
	},
	archivePath: '/dev/null',
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
