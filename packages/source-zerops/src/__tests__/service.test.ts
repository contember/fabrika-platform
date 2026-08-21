import {
	buildZeropsSourceCancelRequest,
	buildZeropsSourceCredentialActivateRequestV2,
	buildZeropsSourceCredentialBundleV2,
	buildZeropsSourceCredentialStatusRequestV2,
	buildZeropsSourceInstallationsVerifyRequest,
	buildZeropsSourceResolveRequest,
	buildZeropsSourceResolveRequestV2,
	buildZeropsSourceUploadRequest,
	buildZeropsSourceUploadRequestV2,
	buildZeropsSourceWebhookConfigureRequest,
	decodeZeropsSourceErrorEnvelope,
	serializeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundleV2,
	ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2,
	ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2,
	ZEROPS_SOURCE_INSTALLATIONS_VERIFY_PATH,
	ZEROPS_SOURCE_WEBHOOK_CONFIGURE_PATH,
} from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { SourceFailure } from '../failure'
import { GitHubConnection, type SourceGitHubClient, type SourceGitHubConnection } from '../github-connection'
import type { RepositoryArchive, RepositorySource } from '../repository'
import { ZeropsSourceService } from '../service'
import type { ArchiveSummary, SourceBytes } from '../tar'

const rpcKey = 'source-rpc-key-that-is-at-least-32-characters'
const repository = { owner: 'contember', name: 'fabrika-platform' }
const commitSha = 'a'.repeat(40)
const descriptorSha256 = 'b'.repeat(64)
const uploadUrl = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=private'
const credentialPem = `-----BEGIN PRIVATE KEY-----
MAMCAQE=
-----END PRIVATE KEY-----
`

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
		archive: async () => {
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

/** A streamed archive whose verdict settles only when the destination has read the whole body. */
function preparedArchive(
	contents = 'tar bytes',
): { archive: RepositoryArchive; disposed: () => boolean } {
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
				outcome.reject(new SourceFailure('upload_failed', 'upload', false, 502))
			},
		},
		disposed: () => didDispose,
	}
}

describe('Zerops source RPC authentication and routing', () => {
	test('serves redacted credential status and activates only a digest-bound verified App', async () => {
		const github = await GitHubConnection.create({
			createClient: async () => ({
				getAuthenticatedApp: async () => ({
					id: 123,
					slug: 'fabrika-test',
					htmlUrl: 'https://github.com/apps/fabrika-test',
					public: false,
					owner: { login: 'contember', type: 'Organization' },
					permissions: { contents: 'read' },
					events: ['push'],
				}),
				getWebhookConfig: async () => ({
					url: 'https://control.example.test/webhooks/github/connection-1',
					contentType: 'json',
					insecureSsl: '0',
				}),
				updateWebhookConfig: async (input) => ({ url: input.url, contentType: 'json', insecureSsl: '0' }),
				resolveOrganizationInstallation: async () => ({
					id: 41,
					accountLogin: 'contember',
					accountType: 'Organization',
					repositorySelection: 'all',
				}),
				resolveRepositoryInstallation: async () => ({
					id: 42,
					accountLogin: 'contember',
					accountType: 'Organization',
					repositorySelection: 'selected',
				}),
				resolveOrganizationInstallationId: async () => 41,
				resolveInstallationId: async () => 42,
				mintRepositoryToken: async () => ({ token: 'must-not-leak', expiresAt: Date.now() + 60_000 }),
			}),
		})
		const service = new ZeropsSourceService({ rpcKey, github, repository: resolvingRepository() })
		const anonymous = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2,
			buildZeropsSourceCredentialStatusRequestV2({ connectionId: 'connection-1', signal: new AbortController().signal }),
		))
		expect(await anonymous.json()).toEqual({ protocolVersion: 2, connectionId: 'connection-1', state: 'anonymous' })

		const credentialBundle = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
			connectionId: 'connection-1',
			githubAppId: '123',
			privateKeyPem: credentialPem,
		}))
		const credentialSha256 = await sha256ZeropsSourceCredentialBundleV2(credentialBundle)
		const activated = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2,
			buildZeropsSourceCredentialActivateRequestV2({
				connectionId: 'connection-1',
				credentialBundle,
				credentialSha256,
				signal: new AbortController().signal,
			}),
		))
		const activatedText = await activated.text()
		expect(activated.status).toBe(200)
		expect(activatedText).not.toContain('PRIVATE KEY')
		expect(activatedText).not.toContain('must-not-leak')
		expect(JSON.parse(activatedText)).toMatchObject({ connectionId: 'connection-1', credentialSha256 })

		const active = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2,
			buildZeropsSourceCredentialStatusRequestV2({ connectionId: 'connection-1', signal: new AbortController().signal }),
		))
		expect(await active.json()).toMatchObject({ state: 'active', connectionId: 'connection-1', credentialSha256 })

		const webhook = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_WEBHOOK_CONFIGURE_PATH,
			buildZeropsSourceWebhookConfigureRequest({
				connectionId: 'connection-1',
				credentialSha256,
				url: 'https://control.example.test/webhooks/github/connection-1',
				secret: 'must-not-leak',
				signal: new AbortController().signal,
			}),
		))
		const webhookText = await webhook.text()
		expect(webhook.status).toBe(200)
		expect(webhookText).not.toContain('must-not-leak')
		const installations = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_INSTALLATIONS_VERIFY_PATH,
			buildZeropsSourceInstallationsVerifyRequest({
				connectionId: 'connection-1',
				credentialSha256,
				scope: { kind: 'organization', organization: 'contember' },
				signal: new AbortController().signal,
			}),
		))
		expect(await installations.json()).toMatchObject({
			connectionId: 'connection-1',
			credentialSha256,
			installation: { status: 'installed', installationId: 41, accountLogin: 'contember', repositorySelection: 'all' },
		})

		const conflictingBundle = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
			connectionId: 'connection-1',
			githubAppId: '124',
			privateKeyPem: credentialPem,
		}))
		const conflict = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2,
			buildZeropsSourceCredentialActivateRequestV2({
				connectionId: 'connection-1',
				credentialBundle: conflictingBundle,
				credentialSha256: await sha256ZeropsSourceCredentialBundleV2(conflictingBundle),
				signal: new AbortController().signal,
			}),
		))
		const conflictText = await conflict.text()
		expect(conflict.status).toBe(409)
		expect(conflictText).not.toContain('PRIVATE KEY')
		expect(decodeZeropsSourceErrorEnvelope(JSON.parse(conflictText)).error).toEqual({
			code: 'credentials_conflict',
			stage: 'credentials',
			retryable: false,
		})
	})

	test('authenticates credential routes before reading bodies and applies the dedicated 128 KiB cap', async () => {
		const service = new ZeropsSourceService({ rpcKey, repository: resolvingRepository() })
		const unauthorized = await service.fetch(
			new Request(`http://source.test${ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2}`, {
				method: 'POST',
				body: '{ not json',
			}),
		)
		expect(unauthorized.status).toBe(401)
		const aboveDefaultLimit = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2,
			{ padding: 'x'.repeat(70 * 1024) },
		))
		expect(aboveDefaultLimit.status).toBe(400)

		const oversized = await service.fetch(rpcRequest(ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2, { padding: 'x'.repeat(129 * 1024) }))
		expect(oversized.status).toBe(413)
		expect(decodeZeropsSourceErrorEnvelope(await oversized.json()).error).toEqual({
			code: 'invalid_request',
			stage: 'validate',
			retryable: false,
		})
	})

	test('fails closed when GitHub administration is requested without an active connection', async () => {
		const github = await GitHubConnection.create({
			createClient: async () => {
				throw new Error('must not be called')
			},
		})
		const service = new ZeropsSourceService({ rpcKey, github, repository: resolvingRepository() })
		const response = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_INSTALLATIONS_VERIFY_PATH,
			buildZeropsSourceInstallationsVerifyRequest({
				connectionId: 'connection-1',
				credentialSha256: 'a'.repeat(64),
				scope: { kind: 'organization', organization: 'contember' },
				signal: new AbortController().signal,
			}),
		))
		expect(response.status).toBe(409)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'credentials_conflict',
			stage: 'credentials',
			retryable: false,
		})
	})

	test('stops reading an authenticated credential body when the caller aborts', async () => {
		const service = new ZeropsSourceService({ rpcKey, repository: resolvingRepository() })
		const controller = new AbortController()
		const started = Promise.withResolvers<void>()
		const body = new TransformStream<Uint8Array, Uint8Array>()
		const writer = body.writable.getWriter()
		const responsePromise = service.fetch(
			new Request(`http://source.test${ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${rpcKey}`, 'content-type': 'application/json' },
				body: body.readable,
				signal: controller.signal,
			}),
		)
		void writer.write(new TextEncoder().encode('{')).then(() => started.resolve())
		await started.promise
		controller.abort()
		const response = await responsePromise
		expect(response.status).toBe(409)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'cancelled',
			stage: 'credentials',
			retryable: false,
		})
	})

	test('bounds the complete authenticated credential request including body read', async () => {
		const service = new ZeropsSourceService({ rpcKey, repository: resolvingRepository(), credentialTimeoutMs: 5 })
		const body = new TransformStream<Uint8Array, Uint8Array>()
		const writer = body.writable.getWriter()
		void writer.write(new TextEncoder().encode('{'))
		const response = await service.fetch(
			new Request(`http://source.test${ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${rpcKey}`, 'content-type': 'application/json' },
				body: body.readable,
			}),
		)
		expect(response.status).toBe(504)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'internal',
			stage: 'credentials',
			retryable: false,
		})
	})

	test('bounds a credential client import that ignores cancellation and never swaps a late candidate', async () => {
		const createStarted = Promise.withResolvers<void>()
		const candidate = Promise.withResolvers<SourceGitHubClient>()
		const github = await GitHubConnection.create({
			createClient: () => {
				createStarted.resolve()
				return candidate.promise
			},
		})
		const service = new ZeropsSourceService({
			rpcKey,
			github,
			repository: resolvingRepository(),
			credentialTimeoutMs: 5,
		})
		const credentialBundle = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
			connectionId: 'connection-1',
			githubAppId: '123',
			privateKeyPem: credentialPem,
		}))
		const responsePromise = service.fetch(rpcRequest(
			ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2,
			buildZeropsSourceCredentialActivateRequestV2({
				connectionId: 'connection-1',
				credentialBundle,
				credentialSha256: await sha256ZeropsSourceCredentialBundleV2(credentialBundle),
				signal: new AbortController().signal,
			}),
		))
		await createStarted.promise
		const response = await responsePromise
		expect(response.status).toBe(504)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'internal',
			stage: 'credentials',
			retryable: false,
		})
		expect(github.snapshotV2('connection-1')).toBeUndefined()
		candidate.resolve({
			getAuthenticatedApp: async () => ({
				id: 123,
				slug: 'late-candidate',
				htmlUrl: 'https://github.com/apps/late-candidate',
				public: false,
				owner: { login: 'contember', type: 'Organization' },
				permissions: { contents: 'read' },
				events: ['push'],
			}),
			resolveInstallationId: async () => 42,
			mintRepositoryToken: async () => ({ token: 'must-not-leak', expiresAt: Date.now() + 60_000 }),
		})
		await Bun.sleep(0)
		expect(github.snapshotV2('connection-1')).toBeUndefined()
	})

	test('marks a timeout after webhook PATCH dispatch and hanging readback as non-retryable', async () => {
		const readStarted = Promise.withResolvers<void>()
		const github = await GitHubConnection.create({
			createClient: async () => ({
				getAuthenticatedApp: async () => ({
					id: 123,
					slug: 'fabrika-test',
					htmlUrl: 'https://github.com/apps/fabrika-test',
					public: false,
					owner: { login: 'contember', type: 'Organization' },
					permissions: { contents: 'read' },
					events: ['push'],
				}),
				getWebhookConfig: async () => {
					readStarted.resolve()
					return await new Promise(() => {})
				},
				updateWebhookConfig: async (input) => ({ url: input.url, contentType: 'json', insecureSsl: '0' }),
				resolveInstallationId: async () => 42,
				mintRepositoryToken: async () => ({ token: 'must-not-leak', expiresAt: Date.now() + 60_000 }),
			}),
		})
		const credentialBundle = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
			connectionId: 'connection-1',
			githubAppId: '123',
			privateKeyPem: credentialPem,
		}))
		const credentialSha256 = await sha256ZeropsSourceCredentialBundleV2(credentialBundle)
		await github.activateV2('connection-1', credentialBundle, credentialSha256, new AbortController().signal)
		const before = github.snapshotV2('connection-1')
		const service = new ZeropsSourceService({ rpcKey, github, repository: resolvingRepository(), credentialTimeoutMs: 5 })
		const responsePromise = service.fetch(rpcRequest(
			ZEROPS_SOURCE_WEBHOOK_CONFIGURE_PATH,
			buildZeropsSourceWebhookConfigureRequest({
				connectionId: 'connection-1',
				credentialSha256,
				url: 'https://control.example.test/webhooks/github/connection-1',
				secret: 'must-not-leak',
				signal: new AbortController().signal,
			}),
		))
		await readStarted.promise
		const response = await responsePromise
		const text = await response.text()
		expect(response.status).toBe(504)
		expect(decodeZeropsSourceErrorEnvelope(JSON.parse(text)).error).toEqual({
			code: 'internal',
			stage: 'credentials',
			retryable: false,
		})
		expect(text).not.toContain('must-not-leak')
		expect(github.snapshotV2('connection-1')).toBe(before)
	})

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
			archive: async () => {
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
			archive: async () => {
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
			archive: async () => {
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

	test('implements resolve without GitHub credentials for a public repository', async () => {
		const service = new ZeropsSourceService({
			rpcKey,
			repository: resolvingRepository(),
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

	test('routes v2 credentials and private bindings without exposing the bundle', async () => {
		const github = await GitHubConnection.create({
			createClient: async () => ({
				getAuthenticatedApp: async () => ({
					id: 123,
					slug: 'fabrika-test',
					htmlUrl: 'https://github.com/apps/fabrika-test',
					public: false,
					owner: { login: 'contember', type: 'Organization' },
					permissions: { contents: 'read' },
					events: ['push'],
				}),
				resolveInstallationId: async () => 42,
				mintRepositoryToken: async () => ({ token: 'must-not-leak', expiresAt: Date.now() + 60_000 }),
			}),
		})
		const resolveInputs: unknown[] = []
		const repositorySource: RepositorySource = {
			resolve: async (input) => {
				resolveInputs.push(input.privateBinding)
				return { commitSha, descriptorSha256 }
			},
			archive: async () => {
				throw new Error('archive not expected')
			},
		}
		const service = new ZeropsSourceService({ rpcKey, github, repository: repositorySource })
		const credentialBundle = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
			connectionId: 'connection-1',
			githubAppId: '123',
			privateKeyPem: credentialPem,
		}))
		const credentialSha256 = await sha256ZeropsSourceCredentialBundleV2(credentialBundle)
		const activated = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2,
			buildZeropsSourceCredentialActivateRequestV2({
				connectionId: 'connection-1',
				credentialBundle,
				credentialSha256,
				signal: new AbortController().signal,
			}),
		))
		const activatedText = await activated.text()
		expect(activated.status).toBe(200)
		expect(activatedText).not.toContain('PRIVATE KEY')
		expect(activatedText).not.toContain('must-not-leak')

		const status = await service.fetch(rpcRequest(
			ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2,
			buildZeropsSourceCredentialStatusRequestV2({ connectionId: 'connection-1', signal: new AbortController().signal }),
		))
		expect(await status.json()).toMatchObject({ protocolVersion: 2, state: 'active', connectionId: 'connection-1' })

		const resolved = await service.fetch(rpcRequest(
			'/v2/source/resolve',
			buildZeropsSourceResolveRequestV2({
				runId: 'run-v2',
				repository,
				requestedRef: 'main',
				privateBinding: { connectionId: 'connection-1', installationId: 42 },
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		))
		expect(await resolved.json()).toEqual({ protocolVersion: 2, runId: 'run-v2', commitSha, descriptorSha256 })
		expect(resolveInputs).toEqual([{ connectionId: 'connection-1', installationId: 42 }])
	})

	test('rejects a partial v2 private binding before repository access', async () => {
		let resolves = 0
		const service = new ZeropsSourceService({
			rpcKey,
			repository: {
				resolve: async () => {
					resolves++
					return { commitSha, descriptorSha256 }
				},
				archive: async () => {
					throw new Error('archive not expected')
				},
			},
		})
		const response = await service.fetch(rpcRequest('/v2/source/resolve', {
			protocolVersion: 2,
			runId: 'run-v2',
			repository,
			requestedRef: 'main',
			privateBinding: { connectionId: 'connection-1' },
			descriptorSha256,
		}))
		expect(response.status).toBe(400)
		expect(resolves).toBe(0)
	})
})

describe('Zerops source upload', () => {
	test('routes v2 upload binding and lets the v1 cancel endpoint stop it', async () => {
		const prepared = preparedArchive()
		const archiveInputs: unknown[] = []
		const started = Promise.withResolvers<void>()
		const service = new ZeropsSourceService({
			rpcKey,
			repository: {
				resolve: async () => ({ commitSha, descriptorSha256 }),
				archive: async (input) => {
					archiveInputs.push(input.privateBinding)
					return prepared.archive
				},
			},
			uploadFetch: async (_destination, init) =>
				await new Promise<Response>((_resolve, reject) => {
					started.resolve()
					init.signal?.addEventListener('abort', () => reject(new DOMException('private reason', 'AbortError')), { once: true })
				}),
		})
		const uploading = service.fetch(rpcRequest(
			'/v2/source/upload',
			buildZeropsSourceUploadRequestV2({
				runId: 'run-v2',
				appVersionId: 'version-v2',
				repository,
				commitSha,
				privateBinding: { connectionId: 'connection-2', installationId: 52 },
				uploadUrl,
				descriptor: { path: 'zerops.yaml', sha256: descriptorSha256 },
				signal: new AbortController().signal,
			}),
		))
		await started.promise
		await service.fetch(rpcRequest(
			'/v1/source/cancel',
			buildZeropsSourceCancelRequest({
				runId: 'run-v2',
				appVersionId: 'version-v2',
				signal: new AbortController().signal,
			}),
		))
		const response = await uploading
		expect(response.status).toBe(409)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'cancelled',
			stage: 'upload',
			retryable: false,
		})
		expect(archiveInputs).toEqual([{ connectionId: 'connection-2', installationId: 52 }])
		expect(prepared.disposed()).toBe(true)
	})
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
				archive: async () => {
					prepares++
					return preparedArchive().archive
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
		const prepared = preparedArchive('verified tar payload')
		let compressed = new Uint8Array()
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			archive: async () => prepared.archive,
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
		expect(prepared.disposed()).toBe(true)
	})

	test('bounds archive preparation plus PUT with one overall non-retryable post-PUT deadline', async () => {
		const prepared = preparedArchive()
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			archive: async (input) => {
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
		expect(prepared.disposed()).toBe(true)
	})

	test('times out archive preparation before PUT without sending destination bytes', async () => {
		let uploads = 0
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			archive: async (input) => {
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
		const prepared = preparedArchive()
		let uploadStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			uploadStarted = resolve
		})
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			archive: async () => prepared.archive,
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
		expect(prepared.disposed()).toBe(true)
	})

	test.each(['transport', 'redirect', 'response body', 'timeout'])(
		'marks a %s failure after PUT starts as non-retryable',
		async (failureKind) => {
			const prepared = preparedArchive()
			const repositorySource: RepositorySource = {
				resolve: async () => ({ commitSha, descriptorSha256 }),
				archive: async () => prepared.archive,
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
			expect(prepared.disposed()).toBe(true)
		},
	)

	test.each([
		{
			name: 'a rejected repository',
			failure: new SourceFailure('archive_rejected', 'archive', false, 422),
			expected: { code: 'archive_rejected', stage: 'archive', retryable: false },
			status: 422,
		},
		{
			name: 'a drifted descriptor',
			failure: new SourceFailure('descriptor_mismatch', 'archive', false, 409),
			expected: { code: 'descriptor_mismatch', stage: 'archive', retryable: false },
			status: 409,
		},
	])('reports $name that aborted an in-flight PUT instead of the transport error', async ({ failure, expected, status }) => {
		const outcome = Promise.withResolvers<ArchiveSummary>()
		outcome.promise.catch(() => {})
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
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
		}
		const service = new ZeropsSourceService({
			rpcKey,
			repository: repositorySource,
			uploadFetch: async (_destination, init) => {
				await new Response(init.body).arrayBuffer()
				return new Response(null, { status: 200 })
			},
		})
		const response = await service.fetch(rpcRequest('/v1/source/upload', uploadRequest()))

		expect(response.status).toBe(status)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual(expected)
	})

	test('preserves caller cancellation that arrives while the archive verdict settles', async () => {
		const verdictAwaited = Promise.withResolvers<void>()
		const releaseVerdict = Promise.withResolvers<void>()
		const completed = verdictAwaited.promise.then(async () => {
			await releaseVerdict.promise
			return { commitSha, descriptorSha256, entryCount: 1, expandedBytes: 9 }
		})
		const repositorySource: RepositorySource = {
			resolve: async () => ({ commitSha, descriptorSha256 }),
			archive: async () => ({
				body: new ReadableStream<SourceBytes>({
					pull: (controller) => controller.close(),
				}),
				completed,
				dispose: () => verdictAwaited.resolve(),
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
		await verdictAwaited.promise
		controller.abort()
		releaseVerdict.resolve()
		const response = await uploading

		expect(response.status).toBe(409)
		expect(decodeZeropsSourceErrorEnvelope(await response.json()).error).toEqual({
			code: 'cancelled',
			stage: 'upload',
			retryable: false,
		})
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
