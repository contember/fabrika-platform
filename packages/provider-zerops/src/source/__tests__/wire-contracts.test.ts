import { describe, expect, test } from 'bun:test'
import {
	buildZeropsSourceCredentialBundleV2,
	decodeZeropsSourceCredentialActivateRequestV2,
	decodeZeropsSourceCredentialActivateResponseV2,
	decodeZeropsSourceCredentialBundleV2,
	decodeZeropsSourceCredentialStatusRequestV2,
	decodeZeropsSourceCredentialStatusResponseV2,
	serializeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundleV2,
} from '../credentials'
import {
	decodeZeropsSourceInstallationsVerifyRequest,
	decodeZeropsSourceInstallationsVerifyResponse,
	decodeZeropsSourceWebhookConfigureRequest,
	decodeZeropsSourceWebhookConfigureResponse,
} from '../github-management'
import {
	decodeZeropsSourceCancelRequest,
	decodeZeropsSourceCancelResponse,
	decodeZeropsSourceErrorEnvelope,
	decodeZeropsSourceResolveRequest,
	decodeZeropsSourceResolveRequestV2,
	decodeZeropsSourceResolveResponse,
	decodeZeropsSourceResolveResponseV2,
	decodeZeropsSourceUploadRequest,
	decodeZeropsSourceUploadRequestV2,
	decodeZeropsSourceUploadResponse,
	decodeZeropsSourceUploadResponseV2,
} from '../operations'
import type { ZeropsSourceCredentialBundleV2, ZeropsSourceInstallationsVerifyRequestV1 } from '../types'

const digest = 'c'.repeat(64)
const commit = 'a'.repeat(40)
const repository = { owner: 'example', name: '.github' }
const connectionId = 'connection:0198'
const privateKeyPem = '-----BEGIN PRIVATE KEY-----\nMAMCAQE=\n-----END PRIVATE KEY-----\n'
const canonicalBundle =
	'{"version":2,"connectionId":"connection:0198","githubAppId":"123","privateKeyPem":"-----BEGIN PRIVATE KEY-----\\nMAMCAQE=\\n-----END PRIVATE KEY-----\\n"}'
const githubApp = {
	id: 123,
	slug: 'example-app',
	htmlUrl: 'https://github.com/apps/example-app',
	public: false,
	owner: { login: 'Example', type: 'Organization' },
	permissions: { contents: 'read' },
	events: ['push'],
}
const resolve = { protocolVersion: 1, runId: 'run-1', repository, requestedRef: 'release/next', descriptorSha256: digest }
const resolveV2 = { ...resolve, protocolVersion: 2 }
const upload = {
	protocolVersion: 1,
	runId: 'run-1',
	appVersionId: 'version-1',
	repository,
	commitSha: commit,
	uploadUrl: 'https://storage.example.test/upload?signature=secret',
	descriptor: { path: 'zerops.yaml', sha256: digest },
}
const uploadV2 = { ...upload, protocolVersion: 2 }
const resolveResponse = { protocolVersion: 1, runId: 'run-1', commitSha: commit, descriptorSha256: digest }
const uploadResponse = { ...resolveResponse, appVersionId: 'version-1' }
const cancel = { protocolVersion: 1, runId: 'run-1', appVersionId: 'version-1' }
const activation = { protocolVersion: 2, connectionId, credentialBundle: canonicalBundle, credentialSha256: digest }
const active = { protocolVersion: 2, connectionId, credentialVersion: 2, credentialSha256: digest, githubApp }
const management = { protocolVersion: 1, connectionId, credentialSha256: digest } satisfies Pick<
	ZeropsSourceInstallationsVerifyRequestV1,
	'protocolVersion' | 'connectionId' | 'credentialSha256'
>
const webhookUrl = 'https://control.example.test/webhooks/github/connection:0198'

const contracts: { name: string; decode: (value: unknown) => unknown; wire: Record<string, unknown> }[] = [
	{ name: 'resolve v1', decode: decodeZeropsSourceResolveRequest, wire: resolve },
	{ name: 'resolve v2', decode: decodeZeropsSourceResolveRequestV2, wire: resolveV2 },
	{ name: 'resolve response v1', decode: decodeZeropsSourceResolveResponse, wire: resolveResponse },
	{ name: 'resolve response v2', decode: decodeZeropsSourceResolveResponseV2, wire: { ...resolveResponse, protocolVersion: 2 } },
	{ name: 'upload v1', decode: decodeZeropsSourceUploadRequest, wire: upload },
	{ name: 'upload v2', decode: decodeZeropsSourceUploadRequestV2, wire: uploadV2 },
	{ name: 'upload response v1', decode: decodeZeropsSourceUploadResponse, wire: uploadResponse },
	{ name: 'upload response v2', decode: decodeZeropsSourceUploadResponseV2, wire: { ...uploadResponse, protocolVersion: 2 } },
	{ name: 'cancel', decode: decodeZeropsSourceCancelRequest, wire: cancel },
	{ name: 'cancel response', decode: decodeZeropsSourceCancelResponse, wire: cancel },
	{ name: 'activation', decode: decodeZeropsSourceCredentialActivateRequestV2, wire: activation },
	{ name: 'activation response', decode: decodeZeropsSourceCredentialActivateResponseV2, wire: active },
	{ name: 'status', decode: decodeZeropsSourceCredentialStatusRequestV2, wire: { protocolVersion: 2, connectionId } },
	{ name: 'anonymous status', decode: decodeZeropsSourceCredentialStatusResponseV2, wire: { protocolVersion: 2, connectionId, state: 'anonymous' } },
	{ name: 'active status', decode: decodeZeropsSourceCredentialStatusResponseV2, wire: { ...active, state: 'active' } },
	{ name: 'webhook', decode: decodeZeropsSourceWebhookConfigureRequest, wire: { ...management, url: webhookUrl, secret: 'webhook-secret' } },
	{
		name: 'webhook response',
		decode: decodeZeropsSourceWebhookConfigureResponse,
		wire: { ...management, webhook: { url: webhookUrl, contentType: 'json', insecureSsl: '0' } },
	},
	{
		name: 'organization verification',
		decode: decodeZeropsSourceInstallationsVerifyRequest,
		wire: { ...management, scope: { kind: 'organization', organization: 'example' } },
	},
	{
		name: 'repository verification',
		decode: decodeZeropsSourceInstallationsVerifyRequest,
		wire: { ...management, scope: { kind: 'repositories', repositories: [repository] } },
	},
	{
		name: 'missing installation',
		decode: decodeZeropsSourceInstallationsVerifyResponse,
		wire: { ...management, installation: { status: 'missing' } },
	},
	{
		name: 'installed installation',
		decode: decodeZeropsSourceInstallationsVerifyResponse,
		wire: { ...management, installation: { status: 'installed', installationId: 1, accountLogin: 'Example', repositorySelection: 'all' } },
	},
]

describe('source wire compatibility fixtures', () => {
	test.each(contracts)('$name preserves output and rejects unsupported versions, fields, and missing values', ({ decode, wire }) => {
		expect(decode(wire)).toEqual(wire)
		for (const protocolVersion of [0, 3, '1', null, undefined]) expect(() => decode({ ...wire, protocolVersion })).toThrow()
		for (const field of Object.keys(wire)) {
			const missing = { ...wire }
			delete missing[field]
			expect(() => decode(missing)).toThrow()
			expect(() => decode({ ...wire, [field]: undefined })).toThrow()
			expect(() => decode({ ...wire, [field]: null })).toThrow()
		}
		expect(() => decode({ ...wire, extension: true })).toThrow('unknown field')
	})

	test.each([
		{ name: 'resolve v1', decode: decodeZeropsSourceResolveRequest, wire: resolve, fields: ['expectedCommitSha', 'githubInstallationId'] },
		{ name: 'resolve v2', decode: decodeZeropsSourceResolveRequestV2, wire: resolveV2, fields: ['expectedCommitSha', 'privateBinding'] },
		{ name: 'upload v1', decode: decodeZeropsSourceUploadRequest, wire: upload, fields: ['githubInstallationId', 'archiveKind'] },
		{ name: 'upload v2', decode: decodeZeropsSourceUploadRequestV2, wire: uploadV2, fields: ['privateBinding'] },
	])('$name distinguishes omitted optional fields from undefined and null', ({ decode, wire, fields }) => {
		const parsed = decode(wire)
		for (const field of fields) {
			expect(Object.hasOwn(parsed, field)).toBe(false)
			expect(() => decode({ ...wire, [field]: undefined })).toThrow('omitted instead of undefined')
			expect(() => decode({ ...wire, [field]: null })).toThrow()
		}
	})

	test('retains lowercasing only for organization scopes and retains repository order', () => {
		expect(decodeZeropsSourceInstallationsVerifyRequest({ ...management, scope: { kind: 'organization', organization: 'ExAmPlE' } })).toEqual({
			...management,
			scope: { kind: 'organization', organization: 'example' },
		})
		const repositories = [{ owner: 'z-owner', name: 'last' }, repository]
		expect(decodeZeropsSourceInstallationsVerifyRequest({ ...management, scope: { kind: 'repositories', repositories } })).toEqual({
			...management,
			scope: { kind: 'repositories', repositories },
		})
		expect(() => decodeZeropsSourceResolveRequest({ ...resolve, repository: { ...repository, owner: 'Example' } })).toThrow()
	})

	test('repository scope keeps its 1–100 entry bound and duplicate rejection', () => {
		const repositories = Array.from({ length: 100 }, (_, index) => ({ owner: 'example', name: `repo-${index}` }))
		expect(decodeZeropsSourceInstallationsVerifyRequest({ ...management, scope: { kind: 'repositories', repositories } }).scope).toEqual({
			kind: 'repositories',
			repositories,
		})
		for (const entries of [[], [...repositories, repository], [repository, repository]]) {
			expect(() => decodeZeropsSourceInstallationsVerifyRequest({ ...management, scope: { kind: 'repositories', repositories: entries } })).toThrow()
		}
	})

	test('retains safe integer limits and nested binding strictness', () => {
		const privateBinding = { connectionId, installationId: Number.MAX_SAFE_INTEGER }
		expect(decodeZeropsSourceResolveRequestV2({ ...resolveV2, privateBinding }).privateBinding).toEqual(privateBinding)
		for (const installationId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '42']) {
			expect(() => decodeZeropsSourceResolveRequestV2({ ...resolveV2, privateBinding: { connectionId, installationId } })).toThrow()
		}
		expect(() => decodeZeropsSourceResolveRequestV2({ ...resolveV2, privateBinding: { ...privateBinding, token: 'secret' } })).toThrow('unknown field')
	})
})

describe('credential bytes and identity restrictions', () => {
	test('freezes the canonical bytes and independently calculated SHA-256', async () => {
		const expected = { version: 2, connectionId, githubAppId: '123', privateKeyPem } satisfies ZeropsSourceCredentialBundleV2
		const bundle = buildZeropsSourceCredentialBundleV2({ connectionId, githubAppId: '123', privateKeyPem })
		expect(bundle).toEqual(expected)
		expect(serializeZeropsSourceCredentialBundleV2(bundle)).toBe(canonicalBundle)
		expect(decodeZeropsSourceCredentialBundleV2(canonicalBundle)).toEqual(expected)
		expect(await sha256ZeropsSourceCredentialBundleV2(canonicalBundle)).toBe('5827d847d15d7bdc34ba4719f00605a2c6f4c1965e5812939a2c46523afa706a')
	})

	test('rejects byte changes even when JSON meaning is unchanged', () => {
		for (
			const value of [
				` ${canonicalBundle}`,
				`${canonicalBundle}\n`,
				canonicalBundle.replace('"version":2', '"version":2,"version":2'),
				canonicalBundle.replace('connection:0198', 'connection\\u003a0198'),
				canonicalBundle.replace('"version":2,"connectionId":"connection:0198"', '"connectionId":"connection:0198","version":2'),
			]
		) expect(() => decodeZeropsSourceCredentialBundleV2(value)).toThrow('canonical JSON')
	})

	test('rejects malformed PEM without trying to repair it', () => {
		for (
			const value of [
				privateKeyPem.replaceAll('\n', '\r\n'),
				privateKeyPem.replace('END PRIVATE KEY', 'END RSA PRIVATE KEY'),
				privateKeyPem.replace('MAMCAQE=', 'AAAA'),
				privateKeyPem.replace('MAMCAQE=', 'MAM=\nCAQE='),
				privateKeyPem.replace('MAMCAQE=', 'MAMCAQE=\n'),
				'not a key',
			]
		) expect(() => buildZeropsSourceCredentialBundleV2({ connectionId, githubAppId: '123', privateKeyPem: value })).toThrow()
	})

	test('keeps GitHub App identity, permission and event constraints closed', () => {
		for (
			const override of [
				{ owner: { login: 'Example', type: 'User' } },
				{ owner: { ...githubApp.owner, id: 1 } },
				{ permissions: { contents: 'write' } },
				{ permissions: { contents: 'read', metadata: 'read' } },
				{ events: [] },
				{ events: ['push', 'push'] },
				{ htmlUrl: 'https://github.com/apps/another-app' },
				{ htmlUrl: 'https://user:secret@github.com/apps/example-app' },
				{ htmlUrl: 'https://github.com/apps/example-app?secret=token' },
			]
		) expect(() => decodeZeropsSourceCredentialActivateResponseV2({ ...active, githubApp: { ...githubApp, ...override } })).toThrow()
	})

	test('status variants reject each other’s fields and unsupported credential versions', () => {
		expect(() => decodeZeropsSourceCredentialStatusResponseV2({ ...active, state: 'anonymous' })).toThrow('unknown field')
		expect(() => decodeZeropsSourceCredentialStatusResponseV2({ protocolVersion: 2, connectionId, state: 'active' })).toThrow()
		expect(() => decodeZeropsSourceCredentialStatusResponseV2({ ...active, state: 'active', credentialVersion: 1 })).toThrow()
	})
})

describe('secret-safe validation errors', () => {
	const secret = 'ghs_never_echo_this_value'
	test.each(contracts)('$name does not expose unknown keys or values in thrown errors', ({ decode, wire }) => {
		let caught: unknown
		try {
			decode({ ...wire, [secret]: secret })
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(Error)
		expect(String(caught)).toContain('unknown field')
		expect(String(caught)).not.toContain(secret)
		expect(JSON.stringify(caught)).not.toContain(secret)
	})

	test('discriminators, enum values and nested unknown keys remain redacted', () => {
		for (
			const operation of [
				() => decodeZeropsSourceErrorEnvelope({ error: { code: secret, stage: secret, retryable: true } }),
				() => decodeZeropsSourceCredentialStatusResponseV2({ protocolVersion: 2, connectionId, state: secret }),
				() =>
					decodeZeropsSourceCredentialActivateResponseV2({ ...active, githubApp: { ...githubApp, permissions: { contents: 'read', [secret]: true } } }),
				() => decodeZeropsSourceCredentialBundleV2(canonicalBundle.replace('"version":2', `"version":"${secret}"`)),
			]
		) {
			let caught: unknown
			try {
				operation()
			} catch (error) {
				caught = error
			}
			expect(caught).toBeInstanceOf(Error)
			expect(String(caught)).not.toContain(secret)
			expect(JSON.stringify(caught)).not.toContain(secret)
		}
	})
})
