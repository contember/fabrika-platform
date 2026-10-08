import type { GitHubMetadataFetch, SourceDownloadFetch, SourceRepository, SourceUploadFetch } from '@fabrika/control/source'
import {
	LOCAL_SOURCE_EMULATOR_ORIGIN,
	LOCAL_SOURCE_UPLOAD_PATH,
	LOCAL_SOURCE_UPLOAD_URL,
	type LocalSourceFixture,
	parseLocalSourceUploadSearch,
} from './local-source-contract'

interface FixtureTransportSource {
	repository: SourceRepository
	fixture: LocalSourceFixture
	archive: Blob
}

/** GitHub and the Zerops upload endpoint as served by the local fixtures; the source code addresses the production origins. */
export function createFixtureTransports(
	sources: readonly FixtureTransportSource[],
	privateUploadFetch: SourceUploadFetch = (url, init) => fetch(url, init),
): {
	metadataFetch: GitHubMetadataFetch
	downloadFetch: SourceDownloadFetch
	uploadFetch: SourceUploadFetch
} {
	return {
		metadataFetch: async (input, init) => {
			init?.signal?.throwIfAborted()
			const url = input instanceof Request ? input.url : String(input)
			if ((init?.method ?? 'GET') !== 'GET') return missing()
			for (const { repository, fixture } of sources) {
				const prefix = `https://api.github.com/repos/${repository.owner}/${repository.name}`
				if (url === `${prefix}/commits/${fixture.commitSha}`) {
					return Response.json({ sha: fixture.commitSha, commit: { tree: { sha: fixture.treeSha } } })
				}
				if (url === `${prefix}/git/trees/${fixture.treeSha}?recursive=1`) {
					return Response.json({ sha: fixture.treeSha, truncated: false, tree: fixture.tree })
				}
				if (url === `${prefix}/contents/zerops.yaml?ref=${fixture.commitSha}`) {
					return new Response(fixture.descriptorContents)
				}
			}
			return missing()
		},
		downloadFetch: async (url, init) => {
			init.signal?.throwIfAborted()
			if ((init.method ?? 'GET') !== 'GET') return missing()
			for (const { repository, fixture, archive } of sources) {
				const codeload = `https://codeload.github.com/${repository.owner}/${repository.name}/legacy.tar.gz/${fixture.commitSha}`
				if (url === `https://api.github.com/repos/${repository.owner}/${repository.name}/tarball/${fixture.commitSha}` && init.redirect === 'manual') {
					return new Response(null, { status: 302, headers: { location: codeload } })
				}
				if (url === codeload && init.redirect === 'error' && !new Headers(init.headers).has('authorization')) {
					return new Response(archive.stream(), { headers: { 'content-type': 'application/gzip' } })
				}
			}
			return missing()
		},
		uploadFetch: async (input, init) => {
			const raw = input instanceof Request ? input.url : String(input)
			const url = new URL(raw)
			parseLocalSourceUploadSearch(url.search)
			if (
				raw !== `${LOCAL_SOURCE_UPLOAD_URL}${url.search}`
				|| init.method !== 'PUT'
				|| init.redirect !== 'error'
				|| new Headers(init.headers).has('authorization')
				|| (input instanceof Request && input.headers.has('authorization'))
			) throw new Error('invalid local source upload destination')
			init.signal?.throwIfAborted()
			return await privateUploadFetch(`${LOCAL_SOURCE_EMULATOR_ORIGIN}${LOCAL_SOURCE_UPLOAD_PATH}${url.search}`, init)
		},
	}
}

function missing(): Response {
	return new Response(null, { status: 404 })
}
