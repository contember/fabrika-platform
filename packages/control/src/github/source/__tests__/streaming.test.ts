import { expect, test } from 'bun:test'
import { createGitHubSource } from '..'
import type { SourceBytes } from '../archive'
import { pullThrough } from '../streams'
import {
	concat,
	DESCRIPTOR,
	descriptor,
	descriptorSha256,
	entry,
	file,
	globalHeader,
	handCommitSha,
	handPrefix,
	repository,
	uploadUrl,
} from './fixtures'

const MiB = 1024 * 1024
const CHUNK_BYTES = 64 * 1024
/** The pipeline holds a few chunks per stage (gunzip, rewrite, gzip, PUT); far below the payload. */
const MAX_LEAD_BYTES = 16 * CHUNK_BYTES
const MAX_RSS_GROWTH_BYTES = 32 * MiB

/** A `git archive`-shaped tarball produced on demand: random (incompressible) content, one chunk per pull. */
function lazyTarball(payloadBytes: number, onProduced: (bytes: number) => void): ReadableStream<SourceBytes> {
	const header = concat(
		globalHeader(handCommitSha),
		file(`${handPrefix}zerops.yaml`, descriptor),
		entry({ name: `${handPrefix}big`, size: payloadBytes }),
	)
	let produced = 0
	let stage: 'header' | 'content' | 'trailer' | 'done' = 'header'
	return new ReadableStream<SourceBytes>({
		pull(controller) {
			if (stage === 'header') {
				stage = 'content'
				controller.enqueue(header)
			} else if (stage === 'content') {
				const chunk = new Uint8Array(Math.min(CHUNK_BYTES, payloadBytes - produced))
				crypto.getRandomValues(chunk)
				produced += chunk.byteLength
				onProduced(chunk.byteLength)
				if (produced === payloadBytes) stage = 'trailer'
				controller.enqueue(chunk)
			} else if (stage === 'trailer') {
				stage = 'done'
				controller.enqueue(new Uint8Array(1024))
			} else {
				controller.close()
			}
		},
	}, { highWaterMark: 0 })
}

interface StreamedUpload {
	readonly expandedBytes: number
	readonly produced: number
	readonly consumed: number
	readonly maxLead: number
	readonly peakRss: number
}

/** Upload one lazily produced repository to a slow destination, measuring how far the producer runs ahead. */
async function streamUpload(payloadBytes: number): Promise<StreamedUpload> {
	let produced = 0
	let consumed = 0
	let maxLead = 0
	let peakRss = 0
	const codeload = 'https://codeload.github.com/contember/fixture/legacy.tar.gz/aaaa?token=x'
	const source = createGitHubSource({
		credentials: { repositoryToken: () => Promise.reject(new Error('no credential expected')), ownerConnectionToken: async () => undefined },
		descriptor: DESCRIPTOR,
		isUploadDestination: (url) => url === uploadUrl,
		downloadFetch: async (url) => {
			if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 302, headers: { location: codeload } })
			// The network holds a producer back; a plain `pipeThrough` here would not (see `pullThrough`).
			return new Response(pullThrough(lazyTarball(payloadBytes, (count) => (produced += count)), new CompressionStream('gzip')))
		},
		uploadFetch: async (_destination, init) => {
			const body = init.body
			if (!(body instanceof ReadableStream)) throw new Error('the upload body is not a stream')
			const reader = body.getReader()
			let reads = 0
			while (true) {
				const result = await reader.read()
				if (result.done) break
				consumed += result.value.byteLength
				maxLead = Math.max(maxLead, produced - consumed)
				// A slow destination: backpressure, not buffering, must hold the producer back.
				if (++reads % 16 === 0) await Bun.sleep(1)
				if (reads % 128 === 0) {
					// Retained memory, not garbage the collector has not reached yet.
					Bun.gc(true)
					peakRss = Math.max(peakRss, process.memoryUsage().rss)
				}
			}
			return new Response(null, { status: 200 })
		},
	})
	const result = await source.upload({
		repository,
		commitSha: handCommitSha,
		descriptorSha256,
		archive: { kind: 'application' },
		uploadUrl,
		signal: new AbortController().signal,
	})
	return { expandedBytes: result.expandedBytes, produced, consumed, maxLead, peakRss }
}

test('streams a 64 MiB repository to a slow destination holding a bounded window, never the whole archive', async () => {
	// The first run pays for JIT and compressor setup, which is not per-upload memory.
	await streamUpload(MiB)
	Bun.gc(true)
	const baseline = process.memoryUsage().rss

	const upload = await streamUpload(64 * MiB)

	expect(upload.expandedBytes).toBe(descriptor.length + 64 * MiB)
	expect(upload.produced).toBe(64 * MiB)
	expect(upload.consumed).toBeGreaterThan(64 * MiB)
	expect(upload.maxLead).toBeLessThan(MAX_LEAD_BYTES)
	expect(upload.peakRss - baseline).toBeLessThan(MAX_RSS_GROWTH_BYTES)
}, 60_000)
