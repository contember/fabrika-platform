import type { GitHubMetadataFetch, SourceDownloadFetch, SourceRepository, SourceUploadFetch } from '@fabrika/control/source'
import { randomBytes } from 'node:crypto'
import {
	LOCAL_SOURCE_EMULATOR_ORIGIN,
	LOCAL_SOURCE_UPLOAD_PATH,
	LOCAL_SOURCE_UPLOAD_URL,
	type LocalSourceFixture,
	parseLocalSourceUploadSearch,
} from './local-source-contract'

/** Every fixture repository was committed on this branch (`local-source-fixtures/generate.ts`). */
const FIXTURE_BRANCH = 'main'

export interface FixtureTransportSource {
	repository: SourceRepository
	fixture: LocalSourceFixture
	archive: Blob
	/** A private repository answers only a caller holding a token the access check accepts; GitHub hides it as 404 otherwise. */
	visibility: 'public' | 'private'
	/** Every file of the commit by path (`readFixtureFiles`); without it only the descriptor is served. */
	files?: ReadonlyMap<string, Uint8Array<ArrayBuffer>>
}

/** Decides whether a request's Authorization header may read a private repository (the GitHub double). */
export interface FixtureRepositoryAccess {
	canRead(authorization: string | null, repository: SourceRepository): boolean
}

export interface FixtureTransportOptions {
	readonly privateUploadFetch?: SourceUploadFetch
	readonly access?: FixtureRepositoryAccess
	/** The commit a repository's branch points at now; undefined leaves it at the first fixture of the repository. */
	readonly branchHead?: (repository: SourceRepository) => string | undefined
}

/** GitHub and the Zerops upload endpoint as served by the local fixtures; the source code addresses the production origins. */
export function createFixtureTransports(
	sources: readonly FixtureTransportSource[],
	options: FixtureTransportOptions = {},
): {
	metadataFetch: GitHubMetadataFetch
	downloadFetch: SourceDownloadFetch
	uploadFetch: SourceUploadFetch
} {
	const access = options.access
	if (access === undefined && sources.some((source) => source.visibility === 'private')) {
		throw new Error('a private fixture repository needs an access check')
	}
	const privateUploadFetch = options.privateUploadFetch ?? ((url, init) => fetch(url, init))
	const readable = (source: FixtureTransportSource, authorization: string | null): boolean =>
		source.visibility === 'public' || access?.canRead(authorization, source.repository) === true
	// The refs GitHub resolves to this fixture's commit: the commit itself and, while the branch points at it, the branch
	// and `HEAD` (the default branch, which is the fixture branch).
	const refsOf = (source: FixtureTransportSource): string[] => {
		const head = options.branchHead?.(source.repository)
		const branchRefs = head === undefined || head === source.fixture.commitSha ? [FIXTURE_BRANCH, `refs/heads/${FIXTURE_BRANCH}`, 'HEAD'] : []
		return [source.fixture.commitSha, ...branchRefs].map(encodeURIComponent)
	}
	// Codeload authorizes a private download by the one-time query token of the API's redirect, never by the installation token.
	// Each grant names the one repository and commit its redirect was issued for.
	const codeloadGrants = new Map<string, string>()
	const spendCodeloadGrant = (url: string, codeload: string): boolean => {
		const grant = new URL(url).searchParams.get('token')
		if (grant === null || url !== `${codeload}?token=${grant}` || codeloadGrants.get(grant) !== codeload) return false
		return codeloadGrants.delete(grant)
	}
	return {
		metadataFetch: async (input, init) => {
			init?.signal?.throwIfAborted()
			const url = input instanceof Request ? input.url : String(input)
			if ((init?.method ?? 'GET') !== 'GET') return missing()
			const authorization = new Headers(init?.headers).get('authorization')
			for (const source of sources) {
				const { repository, fixture } = source
				const prefix = `https://api.github.com/repos/${repository.owner}/${repository.name}`
				if (!url.startsWith(`${prefix}/`) || !readable(source, authorization)) continue
				if (refsOf(source).some((ref) => url === `${prefix}/commits/${ref}`)) {
					return Response.json({ sha: fixture.commitSha, commit: { tree: { sha: fixture.treeSha } } })
				}
				if (url === `${prefix}/git/trees/${fixture.treeSha}?recursive=1`) {
					return Response.json({ sha: fixture.treeSha, truncated: false, tree: fixture.tree })
				}
				const files = source.files ?? new Map([['zerops.yaml', new TextEncoder().encode(fixture.descriptorContents)]])
				for (const [path, bytes] of files) {
					if (url === `${prefix}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${fixture.commitSha}`) {
						return new Response(bytes)
					}
				}
			}
			return missing()
		},
		downloadFetch: async (url, init) => {
			init.signal?.throwIfAborted()
			if ((init.method ?? 'GET') !== 'GET') return missing()
			const authorization = new Headers(init.headers).get('authorization')
			for (const source of sources) {
				const { repository, fixture, archive } = source
				const codeload = `https://codeload.github.com/${repository.owner}/${repository.name}/legacy.tar.gz/${fixture.commitSha}`
				const tarball = `https://api.github.com/repos/${repository.owner}/${repository.name}/tarball/`
				if (
					refsOf(source).some((ref) => url === `${tarball}${ref}`) && init.redirect === 'manual'
					&& readable(source, authorization)
				) {
					if (source.visibility === 'public') return new Response(null, { status: 302, headers: { location: codeload } })
					const grant = randomBytes(24).toString('base64url')
					codeloadGrants.set(grant, codeload)
					return new Response(null, { status: 302, headers: { location: `${codeload}?token=${grant}` } })
				}
				if (!url.startsWith(codeload) || init.redirect !== 'error' || authorization !== null) continue
				const authorized = source.visibility === 'public' ? url === codeload : spendCodeloadGrant(url, codeload)
				if (authorized) return new Response(archive.stream(), { headers: { 'content-type': 'application/gzip' } })
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
