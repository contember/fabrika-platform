import {
	buildZeropsSourceCancelRequest,
	buildZeropsSourceResolveInstallationRequest,
	buildZeropsSourceResolveRequest,
	buildZeropsSourceUploadRequest,
	decodeZeropsSourceErrorEnvelope,
} from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreparedRepositoryArchive, RepositorySource } from '../repository'
import { ZeropsSourceService } from '../service'

const rpcKey = 'source-rpc-key-that-is-at-least-32-characters'
const repository = { owner: 'contember', name: 'fabrika-platform' }
const commitSha = 'a'.repeat(40)
const descriptorSha256 = 'b'.repeat(64)
const uploadUrl = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=private'

function rpcRequest(path: string, value: unknown, key = rpcKey): Request {
	return new Request(`http://source.test${path}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${key}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(value),
	})
}

function resolvingRepository(): RepositorySource {
	return {
		resolve: async (input) => ({
			commitSha,
			descriptorSha256: input.descriptorSha256,
		}),
		prepareArchive: async () => {
			throw new Error('archive not expected')
		},
	}
}

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

async function preparedArchive(
	contents = 'tar bytes',
): Promise<{ archive: PreparedRepositoryArchive; cleaned: () => boolean }> {
	const directory = await mkdtemp(join(tmpdir(), 'source-service-test-'))
	const tarPath = join(directory, 'source.tar')
	await writeFile(tarPath, contents)
	let didClean = false
	return {
		archive: {
			tarPath,
			commitSha,
			descriptorSha256,
			entryCount: 1,
			expandedBytes: contents.length,
			cleanup: async () => {
				didClean = true
				await rm(directory, { recursive: true, force: true })
			},
		},
		cleaned: () => didClean,
	}
}

describe('Zerops source RPC authentication and routing', () => {
	test('authenticates before reading an untrusted body', async () => {
		const service = new ZeropsSourceService({
			rpcKey,
			repository: resolvingRepository(),
		})
		const response = await service.fetch(
			new Request('http://source.test/v1/source/resolve', {
				method: 'POST',
				body: '{ definitely not JSON',
			}),
		)

		expect(response.status).toBe(401)
		expect(decodeZeropsSourceErrorEnvelope(await response.json())).toEqual({
			error: { code: 'unauthorized', stage: 'authenticate', retryable: false },
		})
	})

	test('keeps liveness credential-free but rejects all unknown RPC routes', async () => {
		const service = new ZeropsSourceService({
			rpcKey,
			repository: resolvingRepository(),
		})
		const health = await service.fetch(
			new Request('http://source.test/healthz'),
		)
		expect(health.status).toBe(200)
		expect(await health.json()).toEqual({ status: 'ok' })

		const unknown = await service.fetch(
			rpcRequest('/v1/source/other', { secret: 'must-not-be-read' }),
		)
		expect(unknown.status).toBe(404)
		expect(decodeZeropsSourceErrorEnvelope(await unknown.json()).error).toEqual(
			{ code: 'invalid_request', stage: 'validate', retryable: false },
		)
	})

	test('strictly decodes requests and bounds the body', async () => {
		const service = new ZeropsSourceService({
			rpcKey,
			repository: resolvingRepository(),
		})
		const malformed = await service.fetch(
			rpcRequest('/v1/source/resolve', {
				protocolVersion: 1,
				token: 'ghs_must-not-leak',
			}),
		)
		expect(malformed.status).toBe(400)
		const malformedText = await malformed.text()
		expect(malformedText).not.toContain('ghs_must-not-leak')
		expect(
			decodeZeropsSourceErrorEnvelope(JSON.parse(malformedText)).error,
		).toEqual({ code: 'invalid_request', stage: 'validate', retryable: false })

		const oversized = await service.fetch(
			rpcRequest('/v1/source/resolve', { padding: 'x'.repeat(65 * 1024) }),
		)
		expect(oversized.status).toBe(413)
	})

	test('redacts unexpected repository failures', async () => {
		const secret = 'ghs_secret-in-upstream-error'
		const repositorySource: RepositorySource = {
			resolve: async () => {
				throw new Error(`upstream failed with ${secret}`)
			},
			prepareArchive: async () => {
				throw new Error('archive not expected')
			},
		}
		const service = new ZeropsSourceService({
			rpcKey,
			repository: repositorySource,
		})
		const response = await service.fetch(
			rpcRequest(
				'/v1/source/resolve',
				buildZeropsSourceResolveRequest({
					runId: 'run-1',
					repository,
					requestedRef: 'main',
					descriptorSha256,
					signal: new AbortController().signal,
				}),
			),
		)
		const text = await response.text()
		expect(response.status).toBe(500)
		expect(text).not.toContain(secret)
		expect(decodeZeropsSourceErrorEnvelope(JSON.parse(text)).error).toEqual({
			code: 'internal',
			stage: 'resolve',
			retryable: true,
		})
	})

	test('bounds the whole resolve across sequential phases below the control timeout', async () => {
		const repositorySource: RepositorySource = {
			resolve: async (input) => {
				await delay(20, input.signal)
				await delay(20, input.signal)
				return { commitSha, descriptorSha256 }
			},
			prepareArchive: async () => {
				throw new Error('archive not expected')
			},
		}
		const service = new ZeropsSourceService({
			rpcKey,
			repository: repositorySource,
			operationTimeoutsMs: { resolve: 30 },
		})
		const response = await service.fetch(rpcRequest(
			'/v1/source/resolve',
			buildZeropsSourceResolveRequest({
				runId: 'run-1',
				repository,
				requestedRef: 'main',
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		))

		expect(response.status).toBe(504)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'internal',
			stage: 'resolve',
			retryable: true,
		})
	})

	test('caller cancellation wins over the resolve deadline and stays sanitized', async () => {
		const started = Promise.withResolvers<void>()
		const repositorySource: RepositorySource = {
			resolve: async (input) => {
				started.resolve()
				await delay(1_000, input.signal)
				return { commitSha, descriptorSha256 }
			},
			prepareArchive: async () => {
				throw new Error('archive not expected')
			},
		}
		const service = new ZeropsSourceService({
			rpcKey,
			repository: repositorySource,
			operationTimeoutsMs: { resolve: 500 },
		})
		const controller = new AbortController()
		const responsePromise = service.fetch(
			new Request('http://source.test/v1/source/resolve', {
				method: 'POST',
				headers: { authorization: `Bearer ${rpcKey}`, 'content-type': 'application/json' },
				body: JSON.stringify(buildZeropsSourceResolveRequest({
					runId: 'run-1',
					repository,
					requestedRef: 'main',
					descriptorSha256,
					signal: controller.signal,
				})),
				signal: controller.signal,
			}),
		)
		await started.promise
		controller.abort('private caller reason')
		const response = await responsePromise

		expect(response.status).toBe(409)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'cancelled',
			stage: 'resolve',
			retryable: false,
		})
	})

	test('implements resolve-installation and resolve without GitHub credentials for a public repository', async () => {
		const service = new ZeropsSourceService({
			rpcKey,
			repository: resolvingRepository(),
		})
		const installation = await service.fetch(
			rpcRequest(
				'/v1/installations/resolve',
				buildZeropsSourceResolveInstallationRequest(
					'github.com/contember/fabrika-platform',
				),
			),
		)
		expect(await installation.json()).toEqual({
			protocolVersion: 1,
			githubInstallationId: null,
		})

		const resolve = await service.fetch(
			rpcRequest(
				'/v1/source/resolve',
				buildZeropsSourceResolveRequest({
					runId: 'run-1',
					repository,
					requestedRef: 'main',
					descriptorSha256,
					signal: new AbortController().signal,
				}),
			),
		)
		expect(await resolve.json()).toEqual({
			protocolVersion: 1,
			runId: 'run-1',
			commitSha,
			descriptorSha256,
		})
	})
})

describe('Zerops source upload', () => {
	test.each([
		'https://attacker.test/api/rest/object-storage/upload?signature=x',
		'http://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=x',
		'https://user@proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=x',
		'https://proxy.app-prg1.zerops.io:443/api/rest/object-storage/upload?signature=x',
		'https://proxy.app-prg1.zerops.io/api/rest/object-storage/other?signature=x',
		'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload',
	])(
		'rejects destination %s before preparing or uploading bytes',
		async (destination) => {
			let prepares = 0
			let uploads = 0
			const repositorySource: RepositorySource = {
				resolve: async () => ({ commitSha, descriptorSha256 }),
				prepareArchive: async () => {
					prepares++
					return (await preparedArchive()).archive
				},
			}
			const service = new ZeropsSourceService({
				rpcKey,
				repository: repositorySource,
				uploadFetch: async () => {
					uploads++
					return new Response(null, { status: 200 })
				},
			})
			const input = { ...uploadRequest(), uploadUrl: destination }
			const response = await service.fetch(
				rpcRequest('/v1/source/upload', input),
			)
			expect(response.status).toBe(400)
			expect(prepares).toBe(0)
			expect(uploads).toBe(0)
		},
	)

	test('streams gzip(tar), refuses redirects, and cleans the staged repository', async () => {
		const prepared = await preparedArchive('verified tar payload')
		let compressed = new Uint8Array()
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			prepareArchive: async () => prepared.archive,
		}
		const service = new ZeropsSourceService({
			rpcKey,
			repository: repositorySource,
			uploadFetch: async (destination, init) => {
				expect(destination).toBe(uploadUrl)
				expect(init.method).toBe('PUT')
				expect(init.redirect).toBe('error')
				expect(init.duplex).toBe('half')
				compressed = new Uint8Array(
					await new Response(init.body).arrayBuffer(),
				)
				return new Response('ignored upstream body', { status: 200 })
			},
		})
		const response = await service.fetch(
			rpcRequest('/v1/source/upload', uploadRequest()),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			protocolVersion: 1,
			runId: 'run-1',
			appVersionId: 'version-1',
			commitSha,
			descriptorSha256,
		})
		expect(new TextDecoder().decode(Bun.gunzipSync(compressed))).toBe(
			'verified tar payload',
		)
		expect(prepared.cleaned()).toBe(true)
	})

	test('bounds archive preparation plus PUT with one overall non-retryable post-PUT deadline', async () => {
		const prepared = await preparedArchive()
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			prepareArchive: async (input) => {
				await delay(20, input.signal)
				return prepared.archive
			},
		}
		const service = new ZeropsSourceService({
			rpcKey,
			repository: repositorySource,
			operationTimeoutsMs: { upload: 30 },
			uploadFetch: async (_destination, init) => {
				await delay(20, init.signal ?? new AbortController().signal)
				return new Response(null, { status: 200 })
			},
		})
		const response = await service.fetch(rpcRequest('/v1/source/upload', uploadRequest()))

		expect(response.status).toBe(502)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'upload_failed',
			stage: 'upload',
			retryable: false,
		})
		expect(prepared.cleaned()).toBe(true)
	})

	test('times out archive preparation before PUT without sending destination bytes', async () => {
		let uploads = 0
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			prepareArchive: async (input) => {
				await delay(40, input.signal)
				throw new Error('archive preparation should have been cancelled')
			},
		}
		const service = new ZeropsSourceService({
			rpcKey,
			repository: repositorySource,
			operationTimeoutsMs: { upload: 30 },
			uploadFetch: async () => {
				uploads++
				return new Response(null, { status: 200 })
			},
		})
		const response = await service.fetch(rpcRequest('/v1/source/upload', uploadRequest()))

		expect(response.status).toBe(504)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'internal',
			stage: 'archive',
			retryable: true,
		})
		expect(uploads).toBe(0)
	})

	test('cancels an in-flight upload and cleans its temporary archive', async () => {
		const prepared = await preparedArchive()
		let uploadStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			uploadStarted = resolve
		})
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			prepareArchive: async () => prepared.archive,
		}
		const service = new ZeropsSourceService({
			rpcKey,
			repository: repositorySource,
			uploadFetch: async (_destination, init) =>
				await new Promise<Response>((_resolve, reject) => {
					uploadStarted?.()
					init.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('cancelled', 'AbortError')),
						{ once: true },
					)
				}),
		})
		const uploading = service.fetch(
			rpcRequest('/v1/source/upload', uploadRequest()),
		)
		await started
		const cancel = await service.fetch(
			rpcRequest(
				'/v1/source/cancel',
				buildZeropsSourceCancelRequest({
					runId: 'run-1',
					appVersionId: 'version-1',
					signal: new AbortController().signal,
				}),
			),
		)
		expect(cancel.status).toBe(200)
		const response = await uploading
		expect(response.status).toBe(409)
		expect(
			decodeZeropsSourceErrorEnvelope(await response.json()).error,
		).toEqual({ code: 'cancelled', stage: 'upload', retryable: false })
		expect(prepared.cleaned()).toBe(true)
	})

	test.each(['transport', 'redirect', 'response body', 'timeout', 'cleanup'])(
		'marks a %s failure after PUT starts as non-retryable',
		async (failureKind) => {
			const prepared = await preparedArchive()
			const archive = failureKind === 'cleanup'
				? {
					...prepared.archive,
					cleanup: async () => {
						throw new Error('cleanup failed with private temporary path')
					},
				}
				: prepared.archive
			const repositorySource: RepositorySource = {
				resolve: async () => ({ commitSha, descriptorSha256 }),
				prepareArchive: async () => archive,
			}
			const service = new ZeropsSourceService({
				rpcKey,
				repository: repositorySource,
				uploadTimeoutMs: failureKind === 'timeout' ? 10 : undefined,
				uploadFetch: async (_destination, init) => {
					if (failureKind === 'transport' || failureKind === 'redirect') {
						throw new TypeError('upstream transport details')
					}
					if (failureKind === 'response body') {
						return new Response(
							new ReadableStream({
								cancel: () => {
									throw new Error('upstream response body details')
								},
							}),
							{ status: 200 },
						)
					}
					if (failureKind === 'timeout') {
						return await new Promise<Response>((_resolve, reject) => {
							init.signal?.addEventListener(
								'abort',
								() => reject(new DOMException('timed out', 'AbortError')),
								{ once: true },
							)
						})
					}
					return new Response(null, { status: 200 })
				},
			})
			const response = await service.fetch(
				rpcRequest('/v1/source/upload', uploadRequest()),
			)
			expect(response.status).toBe(502)
			expect(
				decodeZeropsSourceErrorEnvelope(await response.json()).error,
			).toEqual({ code: 'upload_failed', stage: 'upload', retryable: false })
			if (failureKind !== 'cleanup') expect(prepared.cleaned()).toBe(true)
		},
	)

	test('preserves caller cancellation that arrives during post-PUT cleanup', async () => {
		const prepared = await preparedArchive()
		const cleanupStarted = Promise.withResolvers<void>()
		const finishCleanup = Promise.withResolvers<void>()
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			prepareArchive: async () => ({
				...prepared.archive,
				cleanup: async () => {
					cleanupStarted.resolve()
					await finishCleanup.promise
					await prepared.archive.cleanup()
				},
			}),
		}
		const service = new ZeropsSourceService({
			rpcKey,
			repository: repositorySource,
			uploadFetch: async () => new Response(null, { status: 200 }),
		})
		const controller = new AbortController()
		const uploading = service.fetch(
			new Request('http://source.test/v1/source/upload', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${rpcKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(uploadRequest()),
				signal: controller.signal,
			}),
		)
		await cleanupStarted.promise
		controller.abort()
		finishCleanup.resolve()
		const response = await uploading
		expect(response.status).toBe(409)
		expect(
			decodeZeropsSourceErrorEnvelope(await response.json()).error,
		).toEqual({ code: 'cancelled', stage: 'upload', retryable: false })
		expect(prepared.cleaned()).toBe(true)
	})
})

function uploadRequest() {
	return buildZeropsSourceUploadRequest({
		runId: 'run-1',
		appVersionId: 'version-1',
		repository,
		commitSha,
		uploadUrl,
		descriptor: { path: 'zerops.yaml', sha256: descriptorSha256 },
		signal: new AbortController().signal,
	})
}
