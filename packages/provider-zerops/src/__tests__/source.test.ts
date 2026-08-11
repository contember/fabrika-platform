import { describe, expect, test } from 'bun:test'
import {
	buildZeropsSourceCancelRequest,
	buildZeropsSourceCancelResponse,
	buildZeropsSourceErrorEnvelope,
	buildZeropsSourceResolveInstallationRequest,
	buildZeropsSourceResolveInstallationResponse,
	buildZeropsSourceResolveRequest,
	buildZeropsSourceResolveResponse,
	buildZeropsSourceUploadRequest,
	buildZeropsSourceUploadResponse,
	decodeZeropsSourceCancelRequest,
	decodeZeropsSourceCancelResponse,
	decodeZeropsSourceErrorEnvelope,
	decodeZeropsSourceResolveInstallationRequest,
	decodeZeropsSourceResolveInstallationResponse,
	decodeZeropsSourceResolveRequest,
	decodeZeropsSourceResolveResponse,
	decodeZeropsSourceUploadRequest,
	decodeZeropsSourceUploadResponse,
	normalizeZeropsSourceRepository,
	ZEROPS_SOURCE_PROTOCOL_VERSION,
	type ZeropsSourceCancelRequestV1,
	type ZeropsSourceDescriptor,
	type ZeropsSourceErrorEnvelope,
	type ZeropsSourceResolveRequestV1,
	type ZeropsSourceUploadRequestV1,
} from '../source'

const sha40 = 'a'.repeat(40)
const sha64 = 'b'.repeat(64)
const descriptorSha = 'c'.repeat(64)
const repository = { owner: 'contember', name: 'fabrika-platform' }
const signal = (): AbortSignal => new AbortController().signal

const thrownMessage = (operation: () => void): string => {
	try {
		operation()
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('expected operation to throw')
}

describe('Zerops source repository normalization', () => {
	test('normalizes the only accepted GitHub URL shape', () => {
		expect(normalizeZeropsSourceRepository('https://github.com/Contember/Fabrika-Platform.git')).toEqual(repository)
		expect(normalizeZeropsSourceRepository('github.com/Contember/Fabrika-Platform.git')).toEqual(repository)
		expect(normalizeZeropsSourceRepository('github.com/contember/fabrika-platform')).toEqual(repository)
		expect(buildZeropsSourceResolveInstallationRequest('https://github.com/Contember/Fabrika-Platform')).toEqual({
			protocolVersion: 1,
			repository,
		})
	})

	test('allows normalized GitHub repository punctuation including the .github repository', () => {
		expect(normalizeZeropsSourceRepository('https://github.com/Contember/.github')).toEqual({ owner: 'contember', name: '.github' })
		for (const name of ['repo-name', 'repo_name', 'repo.name']) {
			expect(decodeZeropsSourceResolveInstallationRequest({ protocolVersion: 1, repository: { owner: 'contember', name } })).toEqual({
				protocolVersion: 1,
				repository: { owner: 'contember', name },
			})
		}
	})

	test.each(['', '.', '..', 'nested/repo', 'repo\nname', 'Repo'])('rejects invalid or non-normalized repository name %p', (name) => {
		expect(() => decodeZeropsSourceResolveInstallationRequest({ protocolVersion: 1, repository: { owner: 'contember', name } })).toThrow()
	})

	test.each([
		'http://github.com/contember/fabrika-platform',
		'https://gitlab.com/contember/fabrika-platform',
		'https://token@github.com/contember/fabrika-platform',
		'https://github.com/contember/fabrika-platform/tree/main',
		'https://github.com/contember/fabrika-platform?token=secret',
		'https://github.com/contember/fabrika-platform/',
		'https://github.com//contember/fabrika-platform',
		'github.com/contember/fabrika-platform#fragment',
		' github.com/contember/fabrika-platform',
		'github.com/contember/fabrika-platform\n',
		'www.github.com/contember/fabrika-platform',
		'git@github.com:contember/fabrika-platform.git',
	])('rejects arbitrary clone location %s', (url) => {
		expect(() => normalizeZeropsSourceRepository(url)).toThrow()
	})
})

describe('Zerops source resolve-installation wire contract', () => {
	test('binds the normalized repository and nullable installation result', () => {
		expect(decodeZeropsSourceResolveInstallationRequest({ protocolVersion: 1, repository })).toEqual({ protocolVersion: 1, repository })
		expect(buildZeropsSourceResolveInstallationResponse(987)).toEqual({ protocolVersion: 1, githubInstallationId: 987 })
		expect(decodeZeropsSourceResolveInstallationResponse({ protocolVersion: 1, githubInstallationId: null })).toEqual({
			protocolVersion: 1,
			githubInstallationId: null,
		})
	})

	test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])('rejects invalid installation id %p', (githubInstallationId) => {
		expect(() => decodeZeropsSourceResolveInstallationResponse({ protocolVersion: 1, githubInstallationId })).toThrow()
	})
})

describe('Zerops source resolve wire contract', () => {
	const complete: ZeropsSourceResolveRequestV1 = {
		protocolVersion: ZEROPS_SOURCE_PROTOCOL_VERSION,
		runId: 'run:0198',
		repository,
		requestedRef: 'refs/heads/main',
		expectedCommitSha: sha40,
		githubInstallationId: 987,
		descriptorSha256: descriptorSha,
	}

	test('binds every request field and excludes the transport signal', () => {
		expect(buildZeropsSourceResolveRequest({ ...complete, signal: signal() })).toEqual(complete)
		expect(decodeZeropsSourceResolveRequest(complete)).toEqual(complete)
	})

	test('allows the optional expected commit and installation to be absent', () => {
		const minimal: ZeropsSourceResolveRequestV1 = {
			protocolVersion: 1,
			runId: 'run-1',
			repository,
			requestedRef: 'main',
			descriptorSha256: descriptorSha,
		}
		expect(decodeZeropsSourceResolveRequest(minimal)).toEqual(minimal)
	})

	test.each(['refs/heads/main', 'release/next', 'refs/tags/v1.2.3', 'v1.2.3', sha40, sha64])('accepts safe Git ref %s', (requestedRef) => {
		expect(decodeZeropsSourceResolveRequest({ ...complete, requestedRef }).requestedRef).toBe(requestedRef)
	})

	test.each([
		'-main',
		' main',
		'main ',
		'feature\\next',
		'feature..next',
		'feature@{next',
		'feature//next',
		'feature/',
		'main.',
		'main.lock',
		'feature/main.lock',
		'.hidden/main',
		'feature/.hidden',
		'main name',
		'main~next',
		'main^next',
		'main:next',
		'main?next',
		'main*next',
		'main[next',
		`main${String.fromCharCode(0x7f)}next`,
		'@',
	])('rejects unsafe Git ref %p', (requestedRef) => {
		expect(() => decodeZeropsSourceResolveRequest({ ...complete, requestedRef })).toThrow('safe Git ref')
	})

	test.each([
		{},
		{ ...complete, protocolVersion: 2 },
		{ ...complete, runId: '' },
		{ ...complete, requestedRef: '' },
		{ ...complete, requestedRef: 'main\nsecond' },
		{ ...complete, expectedCommitSha: sha40.toUpperCase() },
		{ ...complete, expectedCommitSha: 'a'.repeat(39) },
		{ ...complete, descriptorSha256: sha40 },
		{ ...complete, githubInstallationId: 0 },
		{ ...complete, githubToken: 'ghs_do-not-accept-me' },
		{ ...complete, repository: { ...repository, cloneUrl: 'https://attacker.test/secret' } },
		{ ...complete, repository: { owner: 'Contember', name: 'fabrika-platform' } },
		{ ...complete, repository: { owner: 'contember', name: 'fabrika platform' } },
	])('rejects malformed or extended request %#', (value) => {
		expect(() => decodeZeropsSourceResolveRequest(value)).toThrow()
	})

	test('does not echo a secret-looking unknown request key', () => {
		const secretKey = 'githubToken\nghs_must-not-leak'
		const message = thrownMessage(() => decodeZeropsSourceResolveRequest({ ...complete, [secretKey]: true }))
		expect(message).toContain('unknown field')
		expect(message).not.toContain(secretKey)
		expect(message).not.toContain('ghs_must-not-leak')
	})

	test('binds the run, commit, and descriptor digest in the response', () => {
		const result = { runId: 'run-1', commitSha: sha40, descriptorSha256: descriptorSha }
		expect(buildZeropsSourceResolveResponse(result)).toEqual({ protocolVersion: 1, ...result })
		expect(decodeZeropsSourceResolveResponse({ protocolVersion: 1, ...result })).toEqual({ protocolVersion: 1, ...result })
	})

	test.each([
		{ protocolVersion: 1, runId: 'run-1', commitSha: sha40, descriptorSha256: descriptorSha, uploadUrl: 'https://secret.test' },
		{ protocolVersion: 1, runId: 'run-1', commitSha: sha40, descriptorSha256: descriptorSha, contents: 'zeropsYaml bytes' },
		{ protocolVersion: 1, runId: 'run-1', commitSha: 'ABC', descriptorSha256: descriptorSha },
	])('rejects an invalid or content-bearing resolve response %#', (value) => {
		expect(() => decodeZeropsSourceResolveResponse(value)).toThrow()
	})
})

describe('Zerops source upload wire contract', () => {
	const descriptor: ZeropsSourceDescriptor = { path: 'zerops.yaml', sha256: descriptorSha }
	const complete: ZeropsSourceUploadRequestV1 = {
		protocolVersion: 1,
		runId: 'run-1',
		appVersionId: 'version-1',
		repository,
		commitSha: sha64,
		githubInstallationId: 987,
		uploadUrl: 'https://storage.example.test/upload?signature=secret',
		descriptor,
	}

	test('binds every upload field and excludes the transport signal', () => {
		expect(buildZeropsSourceUploadRequest({ ...complete, signal: signal() })).toEqual(complete)
		expect(decodeZeropsSourceUploadRequest(complete)).toEqual(complete)
	})

	test.each([
		'http://storage.example.test/upload?signature=secret',
		'https://user@storage.example.test/upload?signature=secret',
		'https://user:password@storage.example.test/upload?signature=secret',
		'https://storage.example.test/upload?signature=secret#fragment',
		'https://storage.example.test/upload?signature=secret#',
		'https://storage.example.test/upload',
		'https://storage.example.test/upload?',
		'https://storage.example.test/up load?signature=secret',
		'not a URL?signature=secret',
	])('rejects structurally unsafe upload URL %p', (uploadUrl) => {
		expect(() => decodeZeropsSourceUploadRequest({ ...complete, uploadUrl })).toThrow('signed HTTPS URL')
	})

	test.each([
		{},
		{ ...complete, appVersionId: '' },
		{ ...complete, commitSha: sha64.toUpperCase() },
		{ ...complete, uploadUrl: '' },
		{ ...complete, uploadUrl: 'x'.repeat(4097) },
		{ ...complete, descriptor: { path: 'other.yaml', sha256: descriptorSha } },
		{ ...complete, descriptor: { path: 'zerops.yaml', sha256: descriptorSha, contents: 'secret' } },
		{ ...complete, zeropsToken: 'must-not-cross-this-boundary' },
	])('rejects malformed or extended upload request %#', (value) => {
		expect(() => decodeZeropsSourceUploadRequest(value)).toThrow()
	})

	test('binds the complete upload outcome', () => {
		const result = { runId: 'run-1', appVersionId: 'version-1', commitSha: sha40, descriptorSha256: descriptorSha }
		expect(buildZeropsSourceUploadResponse(result)).toEqual({ protocolVersion: 1, ...result })
		expect(decodeZeropsSourceUploadResponse({ protocolVersion: 1, ...result })).toEqual({ protocolVersion: 1, ...result })
	})

	test.each([
		{ protocolVersion: 1, runId: 'run-1', appVersionId: 'version-1', commitSha: sha40, descriptorSha256: descriptorSha, uploadUrl: 'secret' },
		{ protocolVersion: 1, runId: 'run-1', appVersionId: 'version-1', commitSha: sha40, descriptorSha256: descriptorSha, archive: 'bytes' },
	])('rejects content-bearing upload response %#', (value) => {
		expect(() => decodeZeropsSourceUploadResponse(value)).toThrow()
	})
})

describe('Zerops source cancellation wire contract', () => {
	const request: ZeropsSourceCancelRequestV1 = { protocolVersion: 1, runId: 'run-1', appVersionId: 'version-1' }

	test('binds both cancellation coordinates in the request and success response', () => {
		expect(buildZeropsSourceCancelRequest({ runId: 'run-1', appVersionId: 'version-1', signal: signal() })).toEqual(request)
		expect(decodeZeropsSourceCancelRequest(request)).toEqual(request)
		expect(buildZeropsSourceCancelResponse({ runId: 'run-1', appVersionId: 'version-1' })).toEqual(request)
		expect(decodeZeropsSourceCancelResponse(request)).toEqual(request)
	})

	test('rejects missing or extra cancellation fields', () => {
		expect(() => decodeZeropsSourceCancelRequest({ protocolVersion: 1, runId: 'run-1' })).toThrow()
		expect(() => decodeZeropsSourceCancelResponse({ protocolVersion: 1 })).toThrow()
		expect(() => decodeZeropsSourceCancelResponse({ ...request, message: 'done' })).toThrow()
	})
})

describe('Zerops source redacted error envelope', () => {
	test('builds and decodes only the stable redacted fields', () => {
		const envelope: ZeropsSourceErrorEnvelope = { error: { code: 'upload_failed', stage: 'upload', retryable: true } }
		expect(buildZeropsSourceErrorEnvelope('upload_failed', 'upload', true)).toEqual(envelope)
		expect(decodeZeropsSourceErrorEnvelope(envelope)).toEqual(envelope)
	})

	test.each([
		{ error: { code: 'upstream-secret', stage: 'upload', retryable: true } },
		{ error: { code: 'upload_failed', stage: 'zerops-api', retryable: true } },
		{ error: { code: 'upload_failed', stage: 'upload', retryable: 'yes' } },
		{ error: { code: 'upload_failed', stage: 'upload', retryable: true, message: 'token ghs_secret' } },
		{ error: { code: 'upload_failed', stage: 'upload', retryable: true, upstreamBody: { secret: true } } },
		{ error: { code: 'upload_failed', stage: 'upload', retryable: true }, requestId: 'secret' },
	])('rejects non-redacted error envelope %#', (value) => {
		expect(() => decodeZeropsSourceErrorEnvelope(value)).toThrow()
	})

	test('does not echo a secret-looking unknown error key', () => {
		const secretKey = 'message\nghs_must-not-leak'
		const message = thrownMessage(() =>
			decodeZeropsSourceErrorEnvelope({
				error: { code: 'upload_failed', stage: 'upload', retryable: true, [secretKey]: 'secret' },
			})
		)
		expect(message).toContain('unknown field')
		expect(message).not.toContain(secretKey)
		expect(message).not.toContain('ghs_must-not-leak')
	})
})
