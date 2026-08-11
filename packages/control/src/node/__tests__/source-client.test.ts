import {
	ZEROPS_SOURCE_CANCEL_PATH,
	ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH,
	ZEROPS_SOURCE_RESOLVE_PATH,
	ZEROPS_SOURCE_UPLOAD_PATH,
	type ZeropsSourceResolveInput,
	type ZeropsSourceUploadInput,
} from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { HttpZeropsSourceClient, ZEROPS_SOURCE_RESPONSE_MAX_BYTES, ZeropsSourceClientError, type ZeropsSourceFetch } from '../source-client'

const ORIGIN = 'http://source:3000'
const RPC_KEY = 'source-rpc-key-that-is-at-least-32-characters'
const COMMIT = 'a'.repeat(40)
const DESCRIPTOR_SHA = 'b'.repeat(64)
const UPLOAD_URL = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=upload-secret'
const REPOSITORY = { owner: 'contember', name: 'fabrika-platform' }

interface RecordedCall {
	url: string
	init: RequestInit
}

const jsonResponse = (value: unknown, status = 200): Response =>
	new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const resolveInput = (signal: AbortSignal): ZeropsSourceResolveInput => ({
	runId: 'run-1',
	repository: REPOSITORY,
	requestedRef: 'refs/heads/main',
	expectedCommitSha: COMMIT,
	githubInstallationId: 42,
	descriptorSha256: DESCRIPTOR_SHA,
	signal,
})

const uploadInput = (signal: AbortSignal): ZeropsSourceUploadInput => ({
	runId: 'run-1',
	appVersionId: 'version-1',
	repository: REPOSITORY,
	commitSha: COMMIT,
	githubInstallationId: 42,
	uploadUrl: UPLOAD_URL,
	descriptor: { path: 'zerops.yaml', sha256: DESCRIPTOR_SHA },
	signal,
})

const body = (call: RecordedCall): unknown => {
	if (typeof call.init.body !== 'string') throw new Error('expected a JSON string body')
	const parsed: unknown = JSON.parse(call.init.body)
	return parsed
}

const harness = (respond: ZeropsSourceFetch): { client: HttpZeropsSourceClient; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = []
	const fetch: ZeropsSourceFetch = (url, init) => {
		calls.push({ url, init })
		return respond(url, init)
	}
	return { client: new HttpZeropsSourceClient({ origin: `${ORIGIN}/`, rpcKey: RPC_KEY, fetch }), calls }
}

const clientError = async (operation: Promise<unknown>): Promise<ZeropsSourceClientError> => {
	try {
		await operation
	} catch (error) {
		if (error instanceof ZeropsSourceClientError) return error
		throw error
	}
	throw new Error('expected source client call to fail')
}

describe('HTTP Zerops source client requests', () => {
	test('uses shared endpoints, bearer authentication, JSON, redirect refusal, and each caller signal', async () => {
		const installationSignal = new AbortController().signal
		const resolveSignal = new AbortController().signal
		const uploadSignal = new AbortController().signal
		const cancelSignal = new AbortController().signal
		const { client, calls } = harness(async (url) => {
			if (url.endsWith(ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH)) {
				return jsonResponse({ protocolVersion: 1, githubInstallationId: 42 })
			}
			if (url.endsWith(ZEROPS_SOURCE_RESOLVE_PATH)) {
				return jsonResponse({ protocolVersion: 1, runId: 'run-1', commitSha: COMMIT, descriptorSha256: DESCRIPTOR_SHA })
			}
			if (url.endsWith(ZEROPS_SOURCE_UPLOAD_PATH)) {
				return jsonResponse({
					protocolVersion: 1,
					runId: 'run-1',
					appVersionId: 'version-1',
					commitSha: COMMIT,
					descriptorSha256: DESCRIPTOR_SHA,
				})
			}
			return jsonResponse({ protocolVersion: 1, runId: 'run-1', appVersionId: 'version-1' })
		})

		await expect(client.resolveInstallationId('github.com/Contember/Fabrika-Platform.git', installationSignal)).resolves.toBe(42)
		await expect(client.resolve(resolveInput(resolveSignal))).resolves.toEqual({
			runId: 'run-1',
			commitSha: COMMIT,
			descriptorSha256: DESCRIPTOR_SHA,
		})
		await expect(client.upload(uploadInput(uploadSignal))).resolves.toEqual({
			runId: 'run-1',
			appVersionId: 'version-1',
			commitSha: COMMIT,
			descriptorSha256: DESCRIPTOR_SHA,
		})
		await expect(client.cancel({ runId: 'run-1', appVersionId: 'version-1', signal: cancelSignal })).resolves.toBeUndefined()

		expect(calls.map((call) => call.url)).toEqual([
			`${ORIGIN}${ZEROPS_SOURCE_RESOLVE_INSTALLATION_PATH}`,
			`${ORIGIN}${ZEROPS_SOURCE_RESOLVE_PATH}`,
			`${ORIGIN}${ZEROPS_SOURCE_UPLOAD_PATH}`,
			`${ORIGIN}${ZEROPS_SOURCE_CANCEL_PATH}`,
		])
		expect(calls.map((call) => call.init.signal)).toEqual([installationSignal, resolveSignal, uploadSignal, cancelSignal])
		for (const call of calls) {
			const headers = new Headers(call.init.headers)
			expect(call.init.method).toBe('POST')
			expect(call.init.redirect).toBe('error')
			expect(headers.get('authorization')).toBe(`Bearer ${RPC_KEY}`)
			expect(headers.get('content-type')).toBe('application/json')
			expect(headers.get('accept')).toBe('application/json')
		}
		expect(body(calls[0] ?? missingCall())).toEqual({ protocolVersion: 1, repository: REPOSITORY })
		expect(body(calls[1] ?? missingCall())).toEqual({
			protocolVersion: 1,
			runId: 'run-1',
			repository: REPOSITORY,
			requestedRef: 'refs/heads/main',
			expectedCommitSha: COMMIT,
			githubInstallationId: 42,
			descriptorSha256: DESCRIPTOR_SHA,
		})
		expect(body(calls[2] ?? missingCall())).toEqual({
			protocolVersion: 1,
			runId: 'run-1',
			appVersionId: 'version-1',
			repository: REPOSITORY,
			commitSha: COMMIT,
			githubInstallationId: 42,
			uploadUrl: UPLOAD_URL,
			descriptor: { path: 'zerops.yaml', sha256: DESCRIPTOR_SHA },
		})
		expect(body(calls[3] ?? missingCall())).toEqual({ protocolVersion: 1, runId: 'run-1', appVersionId: 'version-1' })
	})
})

describe('HTTP Zerops source client response validation', () => {
	test('preserves only a valid redacted non-success envelope', async () => {
		const { client } = harness(async () => jsonResponse({ error: { code: 'upload_failed', stage: 'upload', retryable: true } }, 503))
		const error = await clientError(client.upload(uploadInput(new AbortController().signal)))
		expect(error.operation).toBe('upload')
		expect(error.status).toBe(503)
		expect(error.code).toBe('upload_failed')
		expect(error.stage).toBe('upload')
		expect(error.retryable).toBe(true)
		expect(error.message).not.toContain(UPLOAD_URL)
		expect(error.message).not.toContain(RPC_KEY)
	})

	test('does not leak malformed upstream bodies, request URLs, origins, keys, or fetch errors', async () => {
		const responseSecret = 'upstream-body-ghs_must-not-leak'
		const malformed = harness(async () => jsonResponse({ error: { code: 'internal', stage: 'upload', retryable: true, message: responseSecret } }, 500))
		const malformedError = await clientError(malformed.client.upload(uploadInput(new AbortController().signal)))
		expect(malformedError.code).toBe('invalid_response')
		expect(malformedError.retryable).toBe(false)
		for (const secret of [responseSecret, UPLOAD_URL, ORIGIN, RPC_KEY]) {
			expect(malformedError.message).not.toContain(secret)
		}
		const invalidJson = harness(async () => new Response(`not JSON ${responseSecret}`, { status: 502 }))
		const invalidJsonError = await clientError(invalidJson.client.upload(uploadInput(new AbortController().signal)))
		expect(invalidJsonError).toMatchObject({ status: 502, code: 'invalid_response', retryable: false })
		expect(invalidJsonError.message).not.toContain(responseSecret)

		const transport = harness(async () => {
			throw new Error(`fetch failed for ${UPLOAD_URL} using ${RPC_KEY}`)
		})
		const transportError = await clientError(transport.client.upload(uploadInput(new AbortController().signal)))
		expect(transportError.code).toBe('transport_error')
		expect(transportError.status).toBeNull()
		expect(transportError.retryable).toBe(false)
		expect(transportError.message).not.toContain(UPLOAD_URL)
		expect(transportError.message).not.toContain(RPC_KEY)
	})

	test.each([
		['run', { protocolVersion: 1, runId: 'other-run', commitSha: COMMIT, descriptorSha256: DESCRIPTOR_SHA }],
		['commit', { protocolVersion: 1, runId: 'run-1', commitSha: 'c'.repeat(40), descriptorSha256: DESCRIPTOR_SHA }],
		['digest', { protocolVersion: 1, runId: 'run-1', commitSha: COMMIT, descriptorSha256: 'c'.repeat(64) }],
	])('rejects a resolve response with mismatched %s binding', async (_label, response) => {
		const { client } = harness(async () => jsonResponse(response, 201))
		const error = await clientError(client.resolve(resolveInput(new AbortController().signal)))
		expect(error).toMatchObject({ operation: 'resolve', status: 201, code: 'invalid_response' })
	})

	test.each([
		['run', { protocolVersion: 1, runId: 'other-run', appVersionId: 'version-1', commitSha: COMMIT, descriptorSha256: DESCRIPTOR_SHA }],
		['version', { protocolVersion: 1, runId: 'run-1', appVersionId: 'version-2', commitSha: COMMIT, descriptorSha256: DESCRIPTOR_SHA }],
		['commit', { protocolVersion: 1, runId: 'run-1', appVersionId: 'version-1', commitSha: 'c'.repeat(40), descriptorSha256: DESCRIPTOR_SHA }],
		['digest', { protocolVersion: 1, runId: 'run-1', appVersionId: 'version-1', commitSha: COMMIT, descriptorSha256: 'c'.repeat(64) }],
	])('rejects an upload response with mismatched %s binding', async (_label, response) => {
		const { client } = harness(async () => jsonResponse(response))
		const error = await clientError(client.upload(uploadInput(new AbortController().signal)))
		expect(error).toMatchObject({ operation: 'upload', status: 200, code: 'invalid_response' })
		expect(error.message).not.toContain(UPLOAD_URL)
	})

	test.each([
		new Response('not JSON', { status: 200 }),
		jsonResponse({ protocolVersion: 1, githubInstallationId: 42, secret: 'ghs_must-not-leak' }),
	])('rejects malformed success responses without details', async (response) => {
		const { client } = harness(async () => response.clone())
		const error = await clientError(client.resolveInstallationId('github.com/contember/fabrika-platform', new AbortController().signal))
		expect(error).toMatchObject({ operation: 'resolve-installation', status: 200, code: 'invalid_response' })
		expect(error.message).not.toContain('ghs_must-not-leak')
	})

	test('validates the cancel success envelope', async () => {
		const { client } = harness(async () => jsonResponse({ protocolVersion: 1, runId: 'run-1', appVersionId: 'version-1', message: 'secret' }))
		const error = await clientError(client.cancel({ runId: 'run-1', appVersionId: 'version-1', signal: new AbortController().signal }))
		expect(error).toMatchObject({ operation: 'cancel', status: 200, code: 'invalid_response' })
	})

	test.each([
		{ protocolVersion: 1, runId: 'stale-run', appVersionId: 'version-1' },
		{ protocolVersion: 1, runId: 'run-1', appVersionId: 'stale-version' },
	])('rejects a stale cancel response binding', async (response) => {
		const { client } = harness(async () => jsonResponse(response))
		const error = await clientError(client.cancel({ runId: 'run-1', appVersionId: 'version-1', signal: new AbortController().signal }))
		expect(error).toMatchObject({ operation: 'cancel', status: 200, code: 'invalid_response' })
	})

	test('keeps ambiguous upload failures non-retryable while read-only failures may retry', async () => {
		const redirectFailure = async (): Promise<Response> => {
			throw new TypeError(`redirect refused for ${UPLOAD_URL}`)
		}
		const upload = harness(redirectFailure)
		const uploadError = await clientError(upload.client.upload(uploadInput(new AbortController().signal)))
		expect(uploadError).toMatchObject({ operation: 'upload', code: 'transport_error', retryable: false })
		expect(uploadError.message).not.toContain(UPLOAD_URL)

		const resolve = harness(redirectFailure)
		const resolveError = await clientError(resolve.client.resolve(resolveInput(new AbortController().signal)))
		expect(resolveError).toMatchObject({ operation: 'resolve', code: 'transport_error', retryable: true })

		const invalidUpload = harness(async () => new Response('not JSON', { status: 503 }))
		const invalidUploadError = await clientError(invalidUpload.client.upload(uploadInput(new AbortController().signal)))
		expect(invalidUploadError).toMatchObject({ operation: 'upload', status: 503, code: 'invalid_response', retryable: false })

		const invalidResolve = harness(async () => new Response('not JSON', { status: 503 }))
		const invalidResolveError = await clientError(invalidResolve.client.resolve(resolveInput(new AbortController().signal)))
		expect(invalidResolveError).toMatchObject({ operation: 'resolve', status: 503, code: 'invalid_response', retryable: true })
	})

	test('preserves cancellation without leaking the abort reason', async () => {
		let preAbortedCalls = 0
		const preAborted = harness(async () => {
			preAbortedCalls++
			throw new Error('must not run')
		})
		const firstController = new AbortController()
		firstController.abort(`secret abort reason ${UPLOAD_URL}`)
		let firstError: unknown
		try {
			await preAborted.client.resolve(resolveInput(firstController.signal))
		} catch (error) {
			firstError = error
		}
		expect(firstError).toBeInstanceOf(DOMException)
		expect(firstError instanceof DOMException ? firstError.name : '').toBe('AbortError')
		expect(firstError instanceof Error ? firstError.message : '').not.toContain(UPLOAD_URL)
		expect(preAbortedCalls).toBe(0)

		const secondController = new AbortController()
		const rejecting = harness(async () => {
			secondController.abort(`secret abort reason ${RPC_KEY}`)
			throw new Error(`fetch rejected with ${UPLOAD_URL}`)
		})
		let secondError: unknown
		try {
			await rejecting.client.upload(uploadInput(secondController.signal))
		} catch (error) {
			secondError = error
		}
		expect(secondError).toBeInstanceOf(DOMException)
		expect(secondError instanceof DOMException ? secondError.name : '').toBe('AbortError')
		expect(secondError instanceof Error ? secondError.message : '').not.toContain(RPC_KEY)
		expect(secondError instanceof Error ? secondError.message : '').not.toContain(UPLOAD_URL)

		const thirdController = new AbortController()
		const interruptedBody = harness(async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(stream) {
						thirdController.abort(`secret body abort ${UPLOAD_URL}`)
						stream.error(new Error(`body failed with ${RPC_KEY}`))
					},
				}),
				{ status: 200 },
			)
		)
		let thirdError: unknown
		try {
			await interruptedBody.client.resolve(resolveInput(thirdController.signal))
		} catch (error) {
			thirdError = error
		}
		expect(thirdError).toBeInstanceOf(DOMException)
		expect(thirdError instanceof DOMException ? thirdError.name : '').toBe('AbortError')
		expect(thirdError instanceof Error ? thirdError.message : '').not.toContain(RPC_KEY)
		expect(thirdError instanceof Error ? thirdError.message : '').not.toContain(UPLOAD_URL)
	})

	test('rejects oversized success and error bodies before JSON decoding', async () => {
		const sentinel = `ghs_${'x'.repeat(ZEROPS_SOURCE_RESPONSE_MAX_BYTES)}`
		const success = harness(async () => jsonResponse({ sentinel }))
		const successError = await clientError(success.client.resolveInstallationId('github.com/contember/fabrika-platform', new AbortController().signal))
		expect(successError).toMatchObject({ operation: 'resolve-installation', status: 200, code: 'invalid_response', retryable: false })
		expect(successError.message).not.toContain('ghs_')

		const failure = harness(async () => jsonResponse({ error: { code: 'upload_failed', stage: 'upload', retryable: true }, sentinel }, 503))
		const failureError = await clientError(failure.client.upload(uploadInput(new AbortController().signal)))
		expect(failureError).toMatchObject({ operation: 'upload', status: 503, code: 'invalid_response', retryable: false })
		expect(failureError.message).not.toContain('ghs_')
	})

	test('turns invalid input into a typed detail-free error before fetch', async () => {
		let calls = 0
		const { client } = harness(async () => {
			calls++
			return jsonResponse({ protocolVersion: 1 })
		})
		const invalidUrl = 'https://attacker.test/upload-with-secret-but-no-query'
		const error = await clientError(client.upload({ ...uploadInput(new AbortController().signal), uploadUrl: invalidUrl }))
		expect(error).toMatchObject({ operation: 'upload', status: null, code: 'invalid_request', stage: 'validate', retryable: false })
		expect(error.message).not.toContain(invalidUrl)
		expect(calls).toBe(0)
	})
})

describe('HTTP Zerops source client boot validation', () => {
	test.each([
		'ftp://source.test',
		'https://user@source.test',
		'https://source.test/path',
		'https://source.test?query=value',
		'https://source.test?',
		'https://source.test#fragment',
		'https://source.test#',
		' https://source.test',
		'not an origin',
	])('rejects non-bare source origin %p without echoing it', (origin) => {
		const message = thrownMessage(() => new HttpZeropsSourceClient({ origin, rpcKey: RPC_KEY }))
		expect(message).not.toContain(origin)
	})

	test('rejects a short RPC key without echoing it', () => {
		const key = 'short-secret'
		const message = thrownMessage(() => new HttpZeropsSourceClient({ origin: ORIGIN, rpcKey: key }))
		expect(message).not.toContain(key)
	})

	test('accepts bare HTTP and HTTPS origins', () => {
		expect(() => new HttpZeropsSourceClient({ origin: ORIGIN, rpcKey: RPC_KEY })).not.toThrow()
		expect(() => new HttpZeropsSourceClient({ origin: 'https://source.example.test/', rpcKey: RPC_KEY })).not.toThrow()
	})
})

const thrownMessage = (operation: () => unknown): string => {
	try {
		operation()
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('expected operation to throw')
}

const missingCall = (): never => {
	throw new Error('expected recorded source call')
}
