import { buildZeropsSourceResolveRequest, buildZeropsSourceUploadRequest } from '@fabrika/provider-zerops'
import { createSourceRuntime, type SourceRuntime, type SourceUploadFetch } from '@fabrika/source-zerops'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
	LOCAL_SOURCE_APPLICATION_REPOSITORY,
	LOCAL_SOURCE_EMULATOR_ORIGIN,
	LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE,
	LOCAL_SOURCE_PLATFORM_REPOSITORY,
	LOCAL_SOURCE_UPLOAD_PATH,
	LOCAL_SOURCE_UPLOAD_URL,
	type LocalSourceManifest,
	localSourceUploadSearch,
} from '../local-source-contract'
import { prepareLocalSourceFixtures } from '../local-source-fixtures/fixture'
import { createLocalSourceRuntime } from './runtime'
import { createFixtureTransports } from './transports'

const rpcKey = 'local-source-runtime-test-key-00000000'
const env = { FABRIKA_SOURCE_RPC_KEY: rpcKey }
const search = localSourceUploadSearch({ appVersionId: 'version-1', capability: 'c'.repeat(64) })
const uploadUrl = `${LOCAL_SOURCE_UPLOAD_URL}${search}`
let directory: string
let manifest: LocalSourceManifest

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'fabrika-source-runtime-'))
	manifest = await prepareLocalSourceFixtures(directory)
})

afterAll(async () => {
	if (directory !== undefined) await rm(directory, { recursive: true, force: true })
})

function rpc(runtime: SourceRuntime, path: string, body: unknown, key = rpcKey): Promise<Response> {
	return runtime.service.fetch(
		new Request(`http://source${path}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	)
}

function resolveRequest(kind: 'platform' | 'application') {
	const fixture = manifest[kind]
	return buildZeropsSourceResolveRequest({
		runId: `resolve-${kind}`,
		repository: kind === 'platform' ? LOCAL_SOURCE_PLATFORM_REPOSITORY : LOCAL_SOURCE_APPLICATION_REPOSITORY,
		requestedRef: fixture.commitSha,
		expectedCommitSha: fixture.commitSha,
		descriptorSha256: fixture.descriptorSha256,
		signal: new AbortController().signal,
	})
}

function uploadRequest(kind: 'platform' | 'application') {
	const fixture = manifest[kind]
	return buildZeropsSourceUploadRequest({
		runId: `upload-${kind}`,
		appVersionId: 'version-1',
		repository: kind === 'platform' ? LOCAL_SOURCE_PLATFORM_REPOSITORY : LOCAL_SOURCE_APPLICATION_REPOSITORY,
		commitSha: fixture.commitSha,
		uploadUrl,
		descriptor: { path: 'zerops.yaml', sha256: fixture.descriptorSha256 },
		...(kind === 'platform' ? { archiveKind: 'platform' } : {}),
		signal: new AbortController().signal,
	})
}

describe('local immutable source runtime', () => {
	const kinds: ('platform' | 'application')[] = ['platform', 'application']
	for (const kind of kinds) {
		test(`resolves and uploads real ${kind} Git bytes through authenticated RPC`, async () => {
			let uploaded: Uint8Array | undefined
			const runtime = await createLocalSourceRuntime({
				fixtureDirectory: directory,
				env,
				uploadFetch: async (url, init) => {
					expect(String(url)).toBe(`${LOCAL_SOURCE_EMULATOR_ORIGIN}${LOCAL_SOURCE_UPLOAD_PATH}${search}`)
					expect(init.method).toBe('PUT')
					expect(init.redirect).toBe('error')
					expect(init.duplex).toBe('half')
					expect(init.signal).toBeInstanceOf(AbortSignal)
					expect(init.body).toBeInstanceOf(ReadableStream)
					expect(new Headers(init.headers).has('authorization')).toBe(false)
					uploaded = new Uint8Array(await new Response(init.body).arrayBuffer())
					return new Response(null)
				},
			})
			expect((await rpc(runtime, '/v1/source/resolve', resolveRequest(kind), 'wrong-key')).status).toBe(401)
			const resolved = await rpc(runtime, '/v1/source/resolve', resolveRequest(kind))
			expect(resolved.status).toBe(200)
			expect(await resolved.json()).toMatchObject({ commitSha: manifest[kind].commitSha, descriptorSha256: manifest[kind].descriptorSha256 })
			const response = await rpc(runtime, '/v1/source/upload', uploadRequest(kind))
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({ commitSha: manifest[kind].commitSha, descriptorSha256: manifest[kind].descriptorSha256 })
			if (uploaded === undefined) throw new Error('upload did not complete')
			const tar = gunzipSync(uploaded)
			expect(tar.includes(Buffer.from(manifest[kind].descriptorContents))).toBe(true)
			const names = tarHeaders(tar).map(offset => tar.subarray(offset, offset + 100).toString().split('\0')[0])
			expect(names).toContain('zerops.yaml')
			expect(names.some(name => name?.includes('fabrika-local') === true)).toBe(false)
		})
	}

	test('rejects unknown coordinates, mutable refs, wrong expected commits and descriptor digests', async () => {
		const runtime = await createLocalSourceRuntime({ fixtureDirectory: directory, env })
		const base = resolveRequest('application')
		for (
			const body of [
				{ ...base, requestedRef: 'main' },
				{ ...base, repository: { ...base.repository, name: 'unknown' } },
				{ ...base, expectedCommitSha: 'a'.repeat(40) },
				{ ...base, descriptorSha256: 'a'.repeat(64) },
			]
		) expect((await rpc(runtime, '/v1/source/resolve', body)).ok).toBe(false)
	})

	test('forbidden and noncanonical upload destinations never reach the private transport', async () => {
		let calls = 0
		const runtime = await createLocalSourceRuntime({
			fixtureDirectory: directory,
			env,
			uploadFetch: async () => {
				calls++
				return new Response(null)
			},
		})
		for (
			const destination of [
				`http://zerops-emulator:3000${LOCAL_SOURCE_UPLOAD_PATH}${search}`,
				`https://example.com/upload${search}`,
				`${LOCAL_SOURCE_UPLOAD_URL}${search}&extra=1`,
				`${LOCAL_SOURCE_UPLOAD_URL}${search}#fragment`,
				`${LOCAL_SOURCE_UPLOAD_URL}?capability=${'c'.repeat(64)}&appVersionId=version-1&localVersion=1`,
			]
		) {
			expect((await rpc(runtime, '/v1/source/upload', { ...uploadRequest('application'), uploadUrl: destination })).ok).toBe(false)
		}
		expect(calls).toBe(0)
	})

	test('wrong PAX commit and escaping platform symlink cannot complete an upload', async () => {
		const original = gunzipSync(await Bun.file(join(directory, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE)).arrayBuffer())
		const wrongCommit = Buffer.from(original)
		const commitOffset = wrongCommit.indexOf(Buffer.from(manifest.platform.commitSha))
		expect(commitOffset).toBeGreaterThanOrEqual(0)
		wrongCommit.write('f'.repeat(40), commitOffset)
		const unsafeLink = Buffer.from(original)
		const linkOffset = tarHeaders(unsafeLink).find(offset => unsafeLink[offset + 156] === 50)
		if (linkOffset === undefined) throw new Error('platform fixture must include a symlink')
		unsafeLink.fill(0, linkOffset + 157, linkOffset + 257)
		unsafeLink.write('../../outside', linkOffset + 157)
		unsafeLink.fill(32, linkOffset + 148, linkOffset + 156)
		const checksum = unsafeLink.subarray(linkOffset, linkOffset + 512).reduce((total, byte) => total + byte, 0)
		unsafeLink.write(`${checksum.toString(8).padStart(6, '0')}\0 `, linkOffset + 148)
		for (const tar of [wrongCommit, unsafeLink]) {
			let completed = false
			const transports = createFixtureTransports([{
				repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
				fixture: manifest.platform,
				archive: new Blob([gzipSync(tar)]),
			}], async (_url, init) => {
				await new Response(init.body).arrayBuffer()
				completed = true
				return new Response(null)
			})
			const runtime = await createSourceRuntime({ env, ...transports })
			const response = await rpc(runtime, '/v1/source/upload', uploadRequest('platform'))
			expect(response.ok).toBe(false)
			expect(completed).toBe(false)
		}
	})

	test('a mismatched GitHub metadata commit stops platform admission before upload', async () => {
		let uploads = 0
		const transports = createFixtureTransports([{
			repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
			fixture: manifest.platform,
			archive: Bun.file(join(directory, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE)),
		}], async () => {
			uploads++
			return new Response(null)
		})
		const runtime = await createSourceRuntime({
			env,
			...transports,
			metadataFetch: async () => Response.json({ sha: 'a'.repeat(40), commit: { tree: { sha: manifest.platform.treeSha } } }),
		})
		const response = await rpc(runtime, '/v1/source/upload', uploadRequest('platform'))
		expect(response.status).toBe(409)
		expect(await response.json()).toMatchObject({ error: { code: 'commit_mismatch', stage: 'archive' } })
		expect(uploads).toBe(0)
	})

	test('fixture transports accept only exact metadata and redirect coordinates', async () => {
		const { metadataFetch, downloadFetch } = createFixtureTransports([{
			repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
			fixture: manifest.platform,
			archive: Bun.file(join(directory, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE)),
		}])
		const prefix = 'https://api.github.com/repos/fabrika-local/platform-fixture'
		const commit = `${prefix}/commits/${manifest.platform.commitSha}`
		for (const url of [`${commit}?extra=1`, `${commit}#fragment`, commit.replace('api.github.com', 'example.com'), `${prefix}/commits/main`]) {
			expect((await metadataFetch(url)).status).toBe(404)
		}
		const tarball = `${prefix}/tarball/${manifest.platform.commitSha}`
		expect((await downloadFetch(tarball, { redirect: 'follow' })).status).toBe(404)
		const redirect = await downloadFetch(tarball, { redirect: 'manual' })
		expect(redirect.status).toBe(302)
		const location = redirect.headers.get('location')
		if (location === null) throw new Error('missing codeload redirect')
		expect(location).toBe(`https://codeload.github.com/fabrika-local/platform-fixture/legacy.tar.gz/${manifest.platform.commitSha}`)
		expect((await downloadFetch(`${location}?extra=1`, { redirect: 'error' })).status).toBe(404)
		expect((await downloadFetch(location, { redirect: 'error', headers: { authorization: 'Bearer forbidden' } })).status).toBe(404)
		const archive = await downloadFetch(location, { redirect: 'error' })
		expect(new Uint8Array(await archive.arrayBuffer())).toEqual(
			new Uint8Array(await Bun.file(join(directory, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE)).arrayBuffer()),
		)
	})

	test('wrong upload descriptor digest fails the real streaming archive admission', async () => {
		let completed = false
		const runtime = await createLocalSourceRuntime({
			fixtureDirectory: directory,
			env,
			uploadFetch: async (_url, init) => {
				await new Response(init.body).arrayBuffer()
				completed = true
				return new Response(null)
			},
		})
		const request = uploadRequest('application')
		const response = await rpc(runtime, '/v1/source/upload', { ...request, descriptor: { ...request.descriptor, sha256: 'a'.repeat(64) } })
		expect(response.ok).toBe(false)
		expect(completed).toBe(false)
	})

	test('upload mapping preserves stream and signal identity and rejects authorization', async () => {
		const signal = new AbortController().signal
		const body = new Blob(['bytes']).stream()
		let calls = 0
		const transport: SourceUploadFetch = async (_url, init) => {
			calls++
			expect(init.body).toBe(body)
			expect(init.signal).toBe(signal)
			return new Response(null)
		}
		const { uploadFetch } = createFixtureTransports([], transport)
		await uploadFetch(uploadUrl, { method: 'PUT', redirect: 'error', duplex: 'half', body, signal })
		await expect(uploadFetch(uploadUrl, {
			method: 'PUT',
			redirect: 'error',
			duplex: 'half',
			body,
			signal,
			headers: { authorization: 'Bearer forbidden' },
		})).rejects.toThrow('invalid local source upload destination')
		expect(calls).toBe(1)
	})
})

function tarHeaders(tar: Buffer): number[] {
	const result: number[] = []
	for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
		result.push(offset)
		const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, '').trim(), 8)
		if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid test tar header')
		offset += 512 + Math.ceil(size / 512) * 512
	}
	return result
}
