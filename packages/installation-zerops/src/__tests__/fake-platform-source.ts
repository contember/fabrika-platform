import type { PreparedPlatformSource } from '../platform-source'
import type { PlatformUploadFetch } from '../platform-upload'

export const fakePlatformSource = (): PreparedPlatformSource => ({
	commitSha: 'a'.repeat(40),
	descriptor: {
		path: 'zerops.yaml',
		sha256: 'b'.repeat(64),
		contents: 'zerops:\n' + ['iam', 'operations', 'source', 'proxy', 'control'].map((setup) => `  - setup: ${setup}\n`).join(''),
	},
	archivePath: '/dev/null',
	dispose: async () => {},
})

export const fakeSourceCollaborators = {
	prepareSource: async () => fakePlatformSource(),
	uploadFetch: (async (_url, init) => {
		await new Response(init.body).arrayBuffer()
		return new Response(null, { status: 200 })
	}) satisfies PlatformUploadFetch,
}
