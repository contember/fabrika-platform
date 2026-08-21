import { describe, expect, test } from 'bun:test'
import {
	buildZeropsSourceCancelRequest,
	buildZeropsSourceCancelResponse,
	buildZeropsSourceCredentialActivateRequestV2,
	buildZeropsSourceCredentialActivateResponseV2,
	buildZeropsSourceCredentialBundleV2,
	buildZeropsSourceCredentialStatusRequestV2,
	buildZeropsSourceCredentialStatusResponseV2,
	buildZeropsSourceErrorEnvelope,
	buildZeropsSourceInstallationsVerifyRequest,
	buildZeropsSourceInstallationsVerifyResponse,
	buildZeropsSourceResolveRequest,
	buildZeropsSourceResolveRequestV2,
	buildZeropsSourceResolveResponse,
	buildZeropsSourceResolveResponseV2,
	buildZeropsSourceUploadRequest,
	buildZeropsSourceUploadRequestV2,
	buildZeropsSourceUploadResponse,
	buildZeropsSourceUploadResponseV2,
	buildZeropsSourceWebhookConfigureRequest,
	buildZeropsSourceWebhookConfigureResponse,
	decodeZeropsSourceCancelRequest,
	decodeZeropsSourceCancelResponse,
	decodeZeropsSourceCredentialActivateRequestV2,
	decodeZeropsSourceCredentialActivateResponseV2,
	decodeZeropsSourceCredentialBundleV2,
	decodeZeropsSourceCredentialStatusRequestV2,
	decodeZeropsSourceCredentialStatusResponseV2,
	decodeZeropsSourceErrorEnvelope,
	decodeZeropsSourceInstallationsVerifyRequest,
	decodeZeropsSourceInstallationsVerifyResponse,
	decodeZeropsSourceResolveRequest,
	decodeZeropsSourceResolveRequestV2,
	decodeZeropsSourceResolveResponse,
	decodeZeropsSourceResolveResponseV2,
	decodeZeropsSourceUploadRequest,
	decodeZeropsSourceUploadRequestV2,
	decodeZeropsSourceUploadResponse,
	decodeZeropsSourceUploadResponseV2,
	decodeZeropsSourceWebhookConfigureRequest,
	decodeZeropsSourceWebhookConfigureResponse,
	normalizeZeropsSourceRepository,
	serializeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundleV2,
	ZEROPS_SOURCE_CANCEL_PATH,
	ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2,
	ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2,
	ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2,
	ZEROPS_SOURCE_INSTALLATIONS_VERIFY_PATH,
	ZEROPS_SOURCE_PROTOCOL_VERSION,
	ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
	ZEROPS_SOURCE_RESOLVE_PATH,
	ZEROPS_SOURCE_RESOLVE_PATH_V2,
	ZEROPS_SOURCE_UPLOAD_PATH,
	ZEROPS_SOURCE_UPLOAD_PATH_V2,
	ZEROPS_SOURCE_WEBHOOK_CONFIGURE_PATH,
	type ZeropsSourceCancelRequestV1,
	type ZeropsSourceCredentialActivateRequestV2,
	type ZeropsSourceCredentialActivateResponseV2,
	type ZeropsSourceCredentialBundleV2,
	zeropsSourceCredentialEnvV2,
	type ZeropsSourceCredentialStatusResponseV2,
	type ZeropsSourceDescriptor,
	type ZeropsSourceErrorEnvelope,
	type ZeropsSourceGitHubAppIdentityV1,
	type ZeropsSourceResolveRequestV1,
	type ZeropsSourceResolveRequestV2,
	type ZeropsSourceUploadRequestV1,
	type ZeropsSourceUploadRequestV2,
} from '../index'

const sha40 = 'a'.repeat(40)
const sha64 = 'b'.repeat(64)
const descriptorSha = 'c'.repeat(64)
const repository = { owner: 'contember', name: 'fabrika-platform' }
const signal = (): AbortSignal => new AbortController().signal
const privateKeyPem = `-----BEGIN PRIVATE KEY-----
MAMCAQE=
-----END PRIVATE KEY-----
`

const resolveRequestFor = (name: string): Record<string, unknown> => ({
	protocolVersion: 1,
	runId: 'run:0198',
	repository: { owner: 'contember', name },
	requestedRef: 'refs/heads/main',
	descriptorSha256: descriptorSha,
})

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
		expect(
			buildZeropsSourceResolveRequest({
				runId: 'run:0198',
				repository: normalizeZeropsSourceRepository('https://github.com/Contember/Fabrika-Platform'),
				requestedRef: 'refs/heads/main',
				descriptorSha256: descriptorSha,
				signal: signal(),
			}).repository,
		).toEqual(repository)
	})

	test('allows normalized GitHub repository punctuation including the .github repository', () => {
		expect(normalizeZeropsSourceRepository('https://github.com/Contember/.github')).toEqual({ owner: 'contember', name: '.github' })
		for (const name of ['repo-name', 'repo_name', 'repo.name']) {
			expect(decodeZeropsSourceResolveRequest(resolveRequestFor(name)).repository).toEqual({ owner: 'contember', name })
		}
	})

	test.each(['', '.', '..', 'nested/repo', 'repo\nname', 'Repo'])('rejects invalid or non-normalized repository name %p', (name) => {
		expect(() => decodeZeropsSourceResolveRequest(resolveRequestFor(name))).toThrow()
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

describe('Zerops source management wire', () => {
	const identity = {
		id: 123,
		slug: 'fabrika-test',
		htmlUrl: 'https://github.com/apps/fabrika-test',
		public: false,
		owner: { login: 'Contember', type: 'Organization' },
		permissions: { contents: 'read' },
		events: ['push'],
	} satisfies ZeropsSourceGitHubAppIdentityV1

	test('never echoes a secret-looking unknown management key', () => {
		const secretKey = 'privateKey\nghs_must-not-leak'
		const message = thrownMessage(() =>
			decodeZeropsSourceCredentialStatusResponseV2({ protocolVersion: 2, connectionId: 'connection-1', state: 'anonymous', [secretKey]: true })
		)
		expect(message).toContain('unknown field')
		expect(message).not.toContain(secretKey)
		expect(message).not.toContain('ghs_must-not-leak')
	})

	test('strictly binds webhook configuration without returning its secret', () => {
		const input = {
			connectionId: 'connection-1',
			credentialSha256: descriptorSha,
			url: 'https://control.example.test/webhooks/github/connection-1',
			secret: 'must-not-leak',
			signal: signal(),
		}
		const request = buildZeropsSourceWebhookConfigureRequest(input)
		expect(decodeZeropsSourceWebhookConfigureRequest(request)).toEqual(request)
		const response = buildZeropsSourceWebhookConfigureResponse({
			connectionId: input.connectionId,
			credentialSha256: input.credentialSha256,
			webhook: { url: input.url, contentType: 'json', insecureSsl: '0' },
		})
		expect(decodeZeropsSourceWebhookConfigureResponse(response)).toEqual(response)
		expect(JSON.stringify(response)).not.toContain(input.secret)
		expect(ZEROPS_SOURCE_WEBHOOK_CONFIGURE_PATH).toBe('/v1/source/github/webhook/configure')
		expect(() => decodeZeropsSourceWebhookConfigureRequest({ ...request, secret: 'bad\nsecret' })).toThrow()
	})

	test('bounds and exactly decodes organization and repository installation scopes', () => {
		const organization = buildZeropsSourceInstallationsVerifyRequest({
			connectionId: 'connection-1',
			credentialSha256: descriptorSha,
			scope: { kind: 'organization', organization: 'contember' },
			signal: signal(),
		})
		expect(decodeZeropsSourceInstallationsVerifyRequest(organization)).toEqual(organization)
		const repositories = buildZeropsSourceInstallationsVerifyRequest({
			connectionId: 'connection-1',
			credentialSha256: descriptorSha,
			scope: { kind: 'repositories', repositories: [repository] },
			signal: signal(),
		})
		expect(decodeZeropsSourceInstallationsVerifyRequest(repositories)).toEqual(repositories)
		const response = buildZeropsSourceInstallationsVerifyResponse({
			connectionId: 'connection-1',
			credentialSha256: descriptorSha,
			installation: { status: 'installed', installationId: 42, accountLogin: 'contember', repositorySelection: 'selected' },
		})
		expect(decodeZeropsSourceInstallationsVerifyResponse(response)).toEqual(response)
		expect(ZEROPS_SOURCE_INSTALLATIONS_VERIFY_PATH).toBe('/v1/source/github/installations/verify')
		expect(() =>
			decodeZeropsSourceInstallationsVerifyRequest({
				...repositories,
				scope: { kind: 'repositories', repositories: [repository, repository] },
			})
		).toThrow()
		expect(() =>
			decodeZeropsSourceInstallationsVerifyResponse({
				...response,
				installation: { ...response.installation, token: 'secret' },
			})
		).toThrow()
		expect(decodeZeropsSourceInstallationsVerifyResponse({ ...response, installation: { status: 'missing' } }).installation).toEqual({
			status: 'missing',
		})
	})
})

describe('Zerops source v2 credential bundle and management wire', () => {
	const connectionId = 'connection:0198'
	const bundleObject = { version: 2, connectionId, githubAppId: '123', privateKeyPem } satisfies ZeropsSourceCredentialBundleV2
	const bundle =
		`{"version":2,"connectionId":"connection:0198","githubAppId":"123","privateKeyPem":"-----BEGIN PRIVATE KEY-----\\nMAMCAQE=\\n-----END PRIVATE KEY-----\\n"}`
	const identity = {
		id: 123,
		slug: 'fabrika-test',
		htmlUrl: 'https://github.com/apps/fabrika-test',
		public: false,
		owner: { login: 'Contember', type: 'Organization' },
		permissions: { contents: 'read' },
		events: ['push'],
	} satisfies ZeropsSourceGitHubAppIdentityV1

	test('freezes canonical connection-bound bytes, digest, and environment slot', async () => {
		expect(buildZeropsSourceCredentialBundleV2({ connectionId, githubAppId: '123', privateKeyPem })).toEqual(bundleObject)
		expect(serializeZeropsSourceCredentialBundleV2(bundleObject)).toBe(bundle)
		expect(decodeZeropsSourceCredentialBundleV2(bundle)).toEqual(bundleObject)
		expect(await sha256ZeropsSourceCredentialBundleV2(bundle)).toMatch(/^[a-f0-9]{64}$/)
		expect(await zeropsSourceCredentialEnvV2(connectionId)).toBe(
			'GITHUB_APP_CREDENTIALS_V2_f038055c4021ef312b11e68b1cc66a7dc3322527dd89baf25aabcb9c8f88e645',
		)
	})

	test('refuses an unversioned, reordered, or credential-extended bundle', () => {
		expect(() => decodeZeropsSourceCredentialBundleV2(`{"version":1,"githubAppId":"123","privateKeyPem":${JSON.stringify(privateKeyPem)}}`)).toThrow()
		expect(() =>
			decodeZeropsSourceCredentialBundleV2(
				`{"version":2,"githubAppId":"123","privateKeyPem":${JSON.stringify(privateKeyPem)},"connectionId":"${connectionId}"}`,
			)
		).toThrow()
		expect(() => decodeZeropsSourceCredentialBundleV2(`${bundle.slice(0, -1)},"token":"ghs_secret"}`)).toThrow()
	})

	test('binds v2 activation and status to the bundle connection', async () => {
		const credentialSha256 = await sha256ZeropsSourceCredentialBundleV2(bundle)
		const request = {
			protocolVersion: 2,
			connectionId,
			credentialBundle: bundle,
			credentialSha256,
		} satisfies ZeropsSourceCredentialActivateRequestV2
		expect(buildZeropsSourceCredentialActivateRequestV2({ ...request, signal: signal() })).toEqual(request)
		expect(decodeZeropsSourceCredentialActivateRequestV2(request)).toEqual(request)
		expect(() => decodeZeropsSourceCredentialActivateRequestV2({ ...request, connectionId: 'connection:other' })).toThrow(
			'does not match',
		)
		const response = {
			protocolVersion: 2,
			connectionId,
			credentialVersion: 2,
			credentialSha256,
			githubApp: identity,
		} satisfies ZeropsSourceCredentialActivateResponseV2
		expect(buildZeropsSourceCredentialActivateResponseV2(response)).toEqual(response)
		expect(decodeZeropsSourceCredentialActivateResponseV2(response)).toEqual(response)
		expect(buildZeropsSourceCredentialStatusRequestV2({ connectionId, signal: signal() })).toEqual({ protocolVersion: 2, connectionId })
		expect(decodeZeropsSourceCredentialStatusRequestV2({ protocolVersion: 2, connectionId })).toEqual({ protocolVersion: 2, connectionId })
		expect(buildZeropsSourceCredentialStatusResponseV2({ connectionId, state: 'anonymous' })).toEqual({
			protocolVersion: 2,
			connectionId,
			state: 'anonymous',
		})
		const active = { ...response, state: 'active' } satisfies ZeropsSourceCredentialStatusResponseV2
		expect(buildZeropsSourceCredentialStatusResponseV2(active)).toEqual(active)
		expect(decodeZeropsSourceCredentialStatusResponseV2(active)).toEqual(active)
	})

	test('freezes the v2 credential paths and the anonymous v1 transfer paths that survive them', () => {
		expect(ZEROPS_SOURCE_PROTOCOL_VERSION).toBe(1)
		expect(ZEROPS_SOURCE_RESOLVE_PATH).toBe('/v1/source/resolve')
		expect(ZEROPS_SOURCE_UPLOAD_PATH).toBe('/v1/source/upload')
		expect(ZEROPS_SOURCE_CANCEL_PATH).toBe('/v1/source/cancel')
		expect(ZEROPS_SOURCE_PROTOCOL_VERSION_V2).toBe(2)
		expect(ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2).toBe(2)
		expect(ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2).toBe('/v2/source/credentials/activate')
		expect(ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2).toBe('/v2/source/credentials/status')
		expect(ZEROPS_SOURCE_RESOLVE_PATH_V2).toBe('/v2/source/resolve')
		expect(ZEROPS_SOURCE_UPLOAD_PATH_V2).toBe('/v2/source/upload')
	})
})

describe('Zerops source v2 resolve and upload wire contracts', () => {
	const privateBinding = { connectionId: 'connection:0198', installationId: 987 }
	const resolve = {
		protocolVersion: 2,
		runId: 'run:0198',
		repository,
		requestedRef: 'refs/heads/main',
		expectedCommitSha: sha40,
		privateBinding,
		descriptorSha256: descriptorSha,
	} satisfies ZeropsSourceResolveRequestV2
	const descriptor: ZeropsSourceDescriptor = { path: 'zerops.yaml', sha256: descriptorSha }
	const upload = {
		protocolVersion: 2,
		runId: 'run:0198',
		appVersionId: 'version:0198',
		repository,
		commitSha: sha40,
		privateBinding,
		uploadUrl: 'https://storage.example.test/upload?signature=secret',
		descriptor,
	} satisfies ZeropsSourceUploadRequestV2

	test('binds one exact private connection-and-installation object', () => {
		expect(buildZeropsSourceResolveRequestV2({ ...resolve, signal: signal() })).toEqual(resolve)
		expect(decodeZeropsSourceResolveRequestV2(resolve)).toEqual(resolve)
		expect(buildZeropsSourceUploadRequestV2({ ...upload, signal: signal() })).toEqual(upload)
		expect(decodeZeropsSourceUploadRequestV2(upload)).toEqual(upload)
	})

	test('represents public access only by omitting the private binding', () => {
		const { privateBinding: _resolveBinding, ...publicResolve } = resolve
		const { privateBinding: _uploadBinding, ...publicUpload } = upload
		expect(decodeZeropsSourceResolveRequestV2(publicResolve)).toEqual(publicResolve)
		expect(decodeZeropsSourceUploadRequestV2(publicUpload)).toEqual(publicUpload)
	})

	test('rejects partial, flattened, extended, or v1 resolve coordinates', () => {
		for (
			const value of [
				{ ...resolve, privateBinding: { connectionId: privateBinding.connectionId } },
				{ ...resolve, privateBinding: { installationId: privateBinding.installationId } },
				{ ...resolve, privateBinding: { ...privateBinding, token: 'ghs_secret' } },
				{ ...resolve, githubConnectionId: privateBinding.connectionId, githubInstallationId: privateBinding.installationId },
				{ ...resolve, protocolVersion: 1 },
			]
		) expect(() => decodeZeropsSourceResolveRequestV2(value)).toThrow()
	})

	test('rejects partial, malformed, flattened, or extended upload coordinates', () => {
		for (
			const value of [
				{ ...upload, privateBinding: { connectionId: privateBinding.connectionId } },
				{ ...upload, privateBinding: { installationId: privateBinding.installationId } },
				{ ...upload, privateBinding: null },
				{ ...upload, githubInstallationId: privateBinding.installationId },
				{ ...upload, credential: 'secret' },
			]
		) expect(() => decodeZeropsSourceUploadRequestV2(value)).toThrow()
	})

	test('binds v2 responses to the existing result coordinates', () => {
		const resolveResult = { runId: resolve.runId, commitSha: sha40, descriptorSha256: descriptorSha }
		const uploadResult = { ...resolveResult, appVersionId: upload.appVersionId }
		expect(buildZeropsSourceResolveResponseV2(resolveResult)).toEqual({ protocolVersion: 2, ...resolveResult })
		expect(decodeZeropsSourceResolveResponseV2({ protocolVersion: 2, ...resolveResult })).toEqual({ protocolVersion: 2, ...resolveResult })
		expect(buildZeropsSourceUploadResponseV2(uploadResult)).toEqual({ protocolVersion: 2, ...uploadResult })
		expect(decodeZeropsSourceUploadResponseV2({ protocolVersion: 2, ...uploadResult })).toEqual({ protocolVersion: 2, ...uploadResult })
	})

	test('keeps every v1 decoder closed to v2 messages', () => {
		expect(() => decodeZeropsSourceResolveRequest(resolve)).toThrow()
		expect(() => decodeZeropsSourceUploadRequest(upload)).toThrow()
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

describe('webhook configure URL grammar', () => {
	const response = (url: string) =>
		buildZeropsSourceWebhookConfigureResponse({
			connectionId: '01a01e55-9ee5-7035-862b-80b1548b6597',
			credentialSha256: 'a'.repeat(64),
			webhook: { url, contentType: 'json', insecureSsl: '0' },
		})

	test('takes only a connection-scoped route', () => {
		// Every keyed connection appends its id; rejecting this shape broke `configureWebhook` for all of them.
		expect(response('https://control.example.test/webhooks/github/01a01e55-9ee5-7035-862b-80b1548b6597').webhook.url)
			.toBe('https://control.example.test/webhooks/github/01a01e55-9ee5-7035-862b-80b1548b6597')
	})

	test('refuses anything else, the unscoped Cloudflare route included', () => {
		for (
			const url of [
				// Only a Cloudflare composition answers here, and it never reaches this wire (ADR-0039).
				'https://control.example.test/webhooks/github',
				'http://control.example.test/webhooks/github/01a01e55-9ee5-7035-862b-80b1548b6597',
				'https://control.example.test/webhooks/github/one/two',
				'https://control.example.test/webhooks/github/',
				'https://control.example.test/webhooks/github/../admin',
				'https://control.example.test/webhooks/github/a%2Fb',
				'https://control.example.test/webhooks/github/01a01e55-9ee5-7035-862b-80b1548b6597?x=1',
				'https://control.example.test/webhooks/github/01a01e55-9ee5-7035-862b-80b1548b6597#x',
				'https://user:pass@control.example.test/webhooks/github/01a01e55-9ee5-7035-862b-80b1548b6597',
				'https://control.example.test:8443/webhooks/github/01a01e55-9ee5-7035-862b-80b1548b6597',
			]
		) expect(() => response(url)).toThrow()
	})
})
