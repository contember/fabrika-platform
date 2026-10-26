import { afterEach, describe, expect, test } from 'bun:test'
import type { ArchiveSummary, SourceBytes } from '../archive'
import { SourceFailure } from '../failure'
import type { RepositoryArchive } from '../repository'
import { type SourceRepositoryReader, SourceTransport, type SourceTransportOptions } from '../transport'
import type { SourceUploadInput } from '../types'
import {
	descriptor,
	descriptorSha256,
	file,
	gitFixture,
	handCommitSha,
	handPrefix,
	handSource,
	handTarball,
	link,
	parseTar,
	removeFixtureRoots,
	repository,
	sourceFor,
	uploadUrl,
} from './fixtures'

afterEach(removeFixtureRoots)

const commitSha = 'a'.repeat(40)
const UPLOAD_PREFIX = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?'
const isUploadDestination = (url: string): boolean => url.startsWith(UPLOAD_PREFIX)

function transport(options: Partial<SourceTransportOptions> & { readonly repository: SourceRepositoryReader }): SourceTransport {
	return new SourceTransport({ isUploadDestination, ...options })
}

function uploadInput(overrides: Partial<SourceUploadInput> = {}): SourceUploadInput {
	return {
		repository,
		commitSha,
		descriptorSha256,
		archive: { kind: 'application' },
		uploadUrl,
		signal: new AbortController().signal,
		...overrides,
	}
}

const noResolve = (): Promise<never> => Promise.reject(new Error('resolve not expected'))

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const aborted = (): void => {
			clearTimeout(timer)
			reject(new DOMException('aborted with private reason', 'AbortError'))
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', aborted)
			resolve()
		}, ms)
		if (signal.aborted) aborted()
		else signal.addEventListener('abort', aborted, { once: true })
	})
}

/** A streamed archive whose verdict settles only when the destination has read the whole body. */
function preparedArchive(contents = 'tar bytes'): { archive: RepositoryArchive; disposed: () => boolean } {
	const payload = new TextEncoder().encode(contents)
	const outcome = Promise.withResolvers<ArchiveSummary>()
	outcome.promise.catch(() => {})
	const summary: ArchiveSummary = { commitSha, descriptorSha256, entryCount: 1, expandedBytes: payload.byteLength }
	let sent = false
	let didDispose = false
	const body = new ReadableStream<SourceBytes>({
		pull(controller) {
			if (sent) {
				controller.close()
				outcome.resolve(summary)
				return
			}
			sent = true
			controller.enqueue(new Uint8Array(payload))
		},
	})
	return {
		archive: {
			body,
			completed: outcome.promise,
			dispose: () => {
				didDispose = true
				outcome.reject(new SourceFailure('upload_failed', 'upload'))
			},
		},
		disposed: () => didDispose,
	}
}

describe('source resolve', () => {
	test('redacts an unexpected repository failure to its stage', async () => {
		const secret = 'ghs_secret-in-upstream-error'
		const raised = await transport({
			repository: {
				resolve: () => Promise.reject(new Error(`upstream failed with ${secret}`)),
				archive: () => Promise.reject(new Error('archive not expected')),
			},
		}).resolve({ repository, requestedRef: 'main', descriptorSha256, signal: new AbortController().signal }).then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(raised).toBeInstanceOf(SourceFailure)
		expect(raised).toMatchObject({ code: 'internal', stage: 'resolve', message: 'source resolve failed (internal)' })
		expect(JSON.stringify(raised)).not.toContain(secret)
	})

	test('bounds the whole resolve across sequential phases', async () => {
		await expect(
			transport({
				repository: {
					resolve: async (input) => {
						await delay(20, input.signal)
						await delay(20, input.signal)
						return { commitSha, descriptorSha256 }
					},
					archive: () => Promise.reject(new Error('archive not expected')),
				},
				timeoutsMs: { resolve: 30 },
			}).resolve({ repository, requestedRef: 'main', descriptorSha256, signal: new AbortController().signal }),
		).rejects.toMatchObject({
			code: 'internal',
			stage: 'resolve',
		})
	})

	test('caller cancellation wins over the resolve deadline', async () => {
		const started = Promise.withResolvers<void>()
		const controller = new AbortController()
		const resolving = transport({
			repository: {
				resolve: async (input) => {
					started.resolve()
					await delay(1_000, input.signal)
					return { commitSha, descriptorSha256 }
				},
				archive: () => Promise.reject(new Error('archive not expected')),
			},
			timeoutsMs: { resolve: 500 },
		}).resolve({ repository, requestedRef: 'main', descriptorSha256, signal: controller.signal })
		await started.promise
		controller.abort('private caller reason')
		await expect(resolving).rejects.toMatchObject({ code: 'cancelled', stage: 'resolve' })
	})

	test('refuses a timeout above the production bound', () => {
		expect(() => transport({ repository: { resolve: noResolve, archive: noResolve }, timeoutsMs: { upload: 15 * 60_000 + 1 } })).toThrow(
			'source operation timeout is invalid',
		)
	})
})

describe('source upload', () => {
	test.each([
		'https://attacker.test/api/rest/object-storage/upload?signature=secret',
		'http://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=secret',
		'not a URL?secret',
	])('rejects destination %p before preparing or uploading bytes, without naming it', async (destination) => {
		let prepares = 0
		let uploads = 0
		const raised = await transport({
			repository: {
				resolve: noResolve,
				archive: async () => {
					prepares++
					return preparedArchive().archive
				},
			},
			uploadFetch: async () => {
				uploads++
				return new Response(null, { status: 200 })
			},
		}).upload(uploadInput({ uploadUrl: destination })).then(() => undefined, (error: unknown) => error)
		expect(raised).toMatchObject({ code: 'upload_rejected', stage: 'upload' })
		expect(`${String(raised)} ${JSON.stringify(raised)}`).not.toContain('secret')
		expect(prepares).toBe(0)
		expect(uploads).toBe(0)
	})

	test('streams gzip(tar) to the original destination with PUT, half duplex and no redirects', async () => {
		const prepared = preparedArchive('verified tar payload')
		let compressed = new Uint8Array()
		const result = await transport({
			repository: { resolve: noResolve, archive: async () => prepared.archive },
			uploadFetch: async (destination, init) => {
				expect(destination).toBe(uploadUrl)
				expect(init.method).toBe('PUT')
				expect(init.redirect).toBe('manual')
				expect(init.duplex).toBe('half')
				expect(new Headers(init.headers).has('authorization')).toBe(false)
				compressed = new Uint8Array(await new Response(init.body).arrayBuffer())
				return new Response('ignored upstream body', { status: 200 })
			},
		}).upload(uploadInput())

		expect(result).toEqual({ commitSha, descriptorSha256, entryCount: 1, expandedBytes: 20 })
		expect(new TextDecoder().decode(Bun.gunzipSync(compressed))).toBe('verified tar payload')
		expect(prepared.disposed()).toBe(true)
	})

	test('bounds archive preparation plus PUT with one overall deadline', async () => {
		// Nothing here finishes on a timer, so a slow runner cannot move the timeout into the archive stage: the PUT
		// waits for its abort, and the archive's signal aborting with it shows both stages share the one deadline.
		const prepared = preparedArchive()
		let archiveSignal: AbortSignal | undefined
		await expect(
			transport({
				repository: {
					resolve: noResolve,
					archive: async (input) => {
						archiveSignal = input.signal
						return prepared.archive
					},
				},
				timeoutsMs: { upload: 30 },
				uploadFetch: async (_destination, init) =>
					await new Promise<Response>((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => reject(new DOMException('private reason', 'AbortError')), { once: true })
					}),
			}).upload(uploadInput()),
		).rejects.toMatchObject({ code: 'upload_failed', stage: 'upload' })
		expect(archiveSignal?.aborted).toBe(true)
		expect(prepared.disposed()).toBe(true)
	})

	test('times out archive preparation before PUT without sending destination bytes', async () => {
		let uploads = 0
		await expect(
			transport({
				repository: {
					resolve: noResolve,
					archive: async (input) => {
						await delay(40, input.signal)
						throw new Error('archive preparation should have been cancelled')
					},
				},
				timeoutsMs: { upload: 30 },
				uploadFetch: async () => {
					uploads++
					return new Response(null, { status: 200 })
				},
			}).upload(uploadInput()),
		).rejects.toMatchObject({ code: 'internal', stage: 'archive' })
		expect(uploads).toBe(0)
	})

	test('cancels an in-flight upload and disposes its archive', async () => {
		const prepared = preparedArchive()
		const started = Promise.withResolvers<void>()
		const controller = new AbortController()
		const uploading = transport({
			repository: { resolve: noResolve, archive: async () => prepared.archive },
			uploadFetch: async (_destination, init) =>
				await new Promise<Response>((_resolve, reject) => {
					started.resolve()
					init.signal?.addEventListener('abort', () => reject(new DOMException('private reason', 'AbortError')), { once: true })
				}),
		}).upload(uploadInput({ signal: controller.signal }))
		await started.promise
		controller.abort()
		await expect(uploading).rejects.toMatchObject({ code: 'cancelled', stage: 'upload' })
		expect(prepared.disposed()).toBe(true)
	})

	test.each(['transport', 'response body', 'status', 'timeout'])('reports a %s failure after PUT starts as upload_failed', async (failureKind) => {
		const prepared = preparedArchive()
		const raised = await transport({
			repository: { resolve: noResolve, archive: async () => prepared.archive },
			...(failureKind === 'timeout' ? { timeoutsMs: { pipe: 10 } } : {}),
			uploadFetch: async (_destination, init) => {
				if (failureKind === 'transport') throw new TypeError(`upstream transport details ${uploadUrl}`)
				if (failureKind === 'response body') {
					return new Response(new ReadableStream({ cancel: () => Promise.reject(new Error('upstream response body details')) }), { status: 200 })
				}
				if (failureKind === 'status') return new Response('upstream says no', { status: 403 })
				return await new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true })
				})
			},
		}).upload(uploadInput()).then(() => undefined, (error: unknown) => error)
		expect(raised).toMatchObject({ code: 'upload_failed', stage: 'upload' })
		expect(`${String(raised)} ${JSON.stringify(raised)}`).not.toContain('signature=private')
		expect(prepared.disposed()).toBe(true)
	})

	test.each([
		{ name: 'a rejected repository', failure: new SourceFailure('archive_rejected', 'archive') },
		{ name: 'a drifted descriptor', failure: new SourceFailure('descriptor_mismatch', 'archive') },
	])('reports $name that aborted an in-flight PUT instead of the transport error', async ({ failure }) => {
		const outcome = Promise.withResolvers<ArchiveSummary>()
		outcome.promise.catch(() => {})
		await expect(
			transport({
				repository: {
					resolve: noResolve,
					archive: async () => ({
						body: new ReadableStream<SourceBytes>({
							pull: (controller) => {
								outcome.reject(failure)
								controller.error(failure)
							},
						}),
						completed: outcome.promise,
						dispose: () => {},
					}),
				},
				uploadFetch: async (_destination, init) => {
					await new Response(init.body).arrayBuffer()
					return new Response(null, { status: 200 })
				},
			}).upload(uploadInput()),
		).rejects.toBe(failure)
	})

	test('preserves caller cancellation that arrives while the archive verdict settles', async () => {
		const verdictAwaited = Promise.withResolvers<void>()
		const releaseVerdict = Promise.withResolvers<void>()
		const completed = verdictAwaited.promise.then(async () => {
			await releaseVerdict.promise
			return { commitSha, descriptorSha256, entryCount: 1, expandedBytes: 9 }
		})
		const controller = new AbortController()
		const uploading = transport({
			repository: {
				resolve: noResolve,
				archive: async () => ({
					body: new ReadableStream<SourceBytes>({ pull: (stream) => stream.close() }),
					completed,
					dispose: () => verdictAwaited.resolve(),
				}),
			},
			uploadFetch: async () => new Response(null, { status: 200 }),
		}).upload(uploadInput({ signal: controller.signal }))
		await verdictAwaited.promise
		controller.abort()
		releaseVerdict.resolve()
		await expect(uploading).rejects.toMatchObject({ code: 'cancelled', stage: 'upload' })
	})

	test('bounds an upload while it waits in the queue, without preparing its archive', async () => {
		const held = Promise.withResolvers<void>()
		let archives = 0
		const limited = transport({
			maxConcurrentUploads: 1,
			timeoutsMs: { upload: 30 },
			repository: {
				resolve: noResolve,
				archive: async () => {
					archives++
					return preparedArchive().archive
				},
			},
			// The running upload holds its slot past every deadline, so only the queued one's own bound can end its wait.
			uploadFetch: async () => {
				await held.promise
				return new Response(null, { status: 200 })
			},
		})
		const running = limited.upload(uploadInput())
		const queued = limited.upload(uploadInput())
		await expect(queued).rejects.toMatchObject({ code: 'internal', stage: 'archive' })
		held.resolve()
		await expect(running).rejects.toMatchObject({ code: 'upload_failed', stage: 'upload' })
		expect(archives).toBe(1)
	})

	test('streams at most the configured number of uploads and lets a queued caller leave', async () => {
		const releases: Array<() => void> = []
		let archives = 0
		const limited = transport({
			maxConcurrentUploads: 2,
			repository: {
				resolve: noResolve,
				archive: async () => {
					archives++
					return preparedArchive().archive
				},
			},
			uploadFetch: async (_destination, init) => {
				await new Response(init.body).arrayBuffer()
				await new Promise<void>((resolve) => releases.push(resolve))
				return new Response(null, { status: 200 })
			},
		})
		const first = limited.upload(uploadInput())
		const second = limited.upload(uploadInput())
		const leaving = new AbortController()
		const abandoned = limited.upload(uploadInput({ signal: leaving.signal }))
		const third = limited.upload(uploadInput())
		while (releases.length < 2) await Bun.sleep(1)
		await Bun.sleep(10)
		expect(archives).toBe(2)
		leaving.abort()
		await expect(abandoned).rejects.toMatchObject({ code: 'cancelled', stage: 'upload' })
		// Whichever running upload finishes first frees the one slot the queued upload takes.
		releases.shift()?.()
		await Promise.race([first, second])
		while (releases.length < 2) await Bun.sleep(1)
		expect(archives).toBe(3)
		for (const release of releases.splice(0)) release()
		await Promise.all([first, second, third])
		expect(archives).toBe(3)
	})
})

describe('source upload through the real archive rewrite', () => {
	test.each<'markerless' | 'export-ignored-marker'>(['markerless', 'export-ignored-marker'])(
		'rejects actual %s gitlinks in a platform archive before download or PUT',
		async (gitlink) => {
			const fixture = await gitFixture({ gitlink })
			let downloads = 0
			let puts = 0
			await expect(
				transport({
					repository: sourceFor(fixture, { onDownloadAuthorization: () => downloads++ }),
					uploadFetch: async () => {
						puts++
						return new Response(null, { status: 200 })
					},
				}).upload(uploadInput({ commitSha: fixture.commitSha, archive: { kind: 'platform' } })),
			).rejects.toMatchObject({
				code: 'archive_rejected',
				stage: 'archive',
			})
			expect(downloads).toBe(0)
			expect(puts).toBe(0)
		},
	)

	test.each([
		{ name: 'truncated', response: () => Response.json({ sha: 'b'.repeat(40), truncated: true, tree: [] }) },
		{ name: 'malformed', response: () => new Response('{') },
		{ name: 'oversized', response: () => new Response('x'.repeat(7 * 1024 * 1024 + 1)) },
	])('refuses $name tree metadata before download or PUT', async ({ response: treeResponse }) => {
		let downloads = 0
		let puts = 0
		await expect(
			transport({
				repository: handSource(handTarball([file(`${handPrefix}zerops.yaml`, descriptor)]), { treeResponse, onDownloadAuthorization: () => downloads++ }),
				uploadFetch: async () => {
					puts++
					return new Response(null, { status: 200 })
				},
			}).upload(uploadInput({ commitSha: handCommitSha, archive: { kind: 'platform' } })),
		).rejects.toMatchObject({
			code: 'archive_rejected',
			stage: 'archive',
		})
		expect(downloads).toBe(0)
		expect(puts).toBe(0)
	})

	test('a late platform namespace rejection fails the upload even when PUT already started', async () => {
		let putStarted = false
		await expect(
			transport({
				repository: handSource(handTarball([file(`${handPrefix}zerops.yaml`, descriptor), link('AGENTS.md', 'missing')])),
				uploadFetch: async (_destination, init) => {
					putStarted = true
					await new Response(init.body).arrayBuffer().catch(() => {})
					return new Response(null, { status: 200 })
				},
			}).upload(uploadInput({ commitSha: handCommitSha, archive: { kind: 'platform' } })),
		).rejects.toMatchObject({
			code: 'archive_rejected',
			stage: 'archive',
		})
		expect(putStarted).toBe(true)
	})

	test('a platform archive keeps a real git AGENTS.md symlink', async () => {
		const fixture = await gitFixture({ agentsLink: true })
		let uploaded = new Uint8Array()
		const result = await transport({
			repository: sourceFor(fixture),
			uploadFetch: async (_destination, init) => {
				uploaded = new Uint8Array(await new Response(init.body).arrayBuffer())
				return new Response(null, { status: 200 })
			},
		}).upload(uploadInput({ commitSha: fixture.commitSha, archive: { kind: 'platform' } }))
		expect(result).toMatchObject({ commitSha: fixture.commitSha, descriptorSha256 })
		const delivered = parseTar(new Uint8Array(Bun.gunzipSync(uploaded)))
		expect(delivered.find((part) => part.path === 'AGENTS.md')).toMatchObject({ type: '2', linkpath: 'CLAUDE.md', content: new Uint8Array() })
	})

	test('hands the destination gzip(tar) of exactly the rewritten archive', async () => {
		const fixture = await gitFixture({ longPath: 'deeply/nested/but/quite/short.txt' })
		let uploaded = new Uint8Array()
		const result = await transport({
			repository: sourceFor(fixture),
			uploadFetch: async (_destination, init) => {
				uploaded = new Uint8Array(await new Response(init.body).arrayBuffer())
				return new Response(null, { status: 200 })
			},
		}).upload(uploadInput({ commitSha: fixture.commitSha }))
		const delivered = parseTar(new Uint8Array(Bun.gunzipSync(uploaded)))

		expect(result).toMatchObject({ commitSha: fixture.commitSha, descriptorSha256, entryCount: 4 })
		expect(delivered.map((part) => [part.path, part.mode, part.type])).toEqual([
			['.gitattributes', 0o644, '0'],
			['bin/', 0o755, '5'],
			['bin/run', 0o755, '0'],
			['deeply/', 0o755, '5'],
			['deeply/nested/', 0o755, '5'],
			['deeply/nested/but/', 0o755, '5'],
			['deeply/nested/but/quite/', 0o755, '5'],
			['deeply/nested/but/quite/short.txt', 0o644, '0'],
			['zerops.yaml', 0o644, '0'],
		])
		expect(new TextDecoder().decode(delivered.find((part) => part.path === 'zerops.yaml')?.content)).toBe(descriptor)
	})
})
