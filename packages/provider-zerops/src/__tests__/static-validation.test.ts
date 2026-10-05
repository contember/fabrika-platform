import { describe, expect, test } from 'bun:test'
import { readAppVersion, readIntegrationToken, readProject, readService } from '../api/readers'
import { parseServiceEnvResponse } from '../api/service-env-response'
import { zeropsTargetCodec } from '../codec'
import { parseZeropsDescriptor, prepareZeropsDescriptor } from '../descriptor'
import { mapManagedKeys, parseManagedCheckpoint, parseManagedOwner, serializeManagedOwner } from '../managed-environment/protocol'
import { compileFabrikaManifest, parseFabrikaManifest } from '../manifest'
import { zeropsNamespaceTargetCodec } from '../namespace/codec'
import { decodeZeropsNamespaceProxySource } from '../namespace/proxy-source'
import type { ZeropsNamespaceProxySource } from '../namespace/types'
import { SOURCE_DESCRIPTOR } from './fixtures/descriptor'

const owner = {
	protocol: 1,
	appId: 'app',
	environment: 'prod',
	namespaceId: 'namespace',
	projectId: 'project',
	serviceId: 'service',
	hostname: 'api',
}

describe('provider validation compatibility', () => {
	test('API projections retain fallback, inherited-field and explicit-undefined behavior', () => {
		const inherited: unknown = Object.create({ id: 'version', status: 'FUTURE_STATUS', sequence: Number.NaN })
		const version = readAppVersion(inherited)
		expect(version).toEqual({
			id: 'version',
			status: undefined,
			sequence: Number.NaN,
			projectId: undefined,
			serviceStackId: undefined,
			build: undefined,
		})
		expect(Object.hasOwn(version, 'build')).toBe(true)
		expect(readService({ id: 4, name: null, subdomainAccess: 'true', autoscalingProfileId: 8 })).toEqual({
			id: '',
			name: '',
			projectId: undefined,
			status: undefined,
			base: undefined,
			activeAppVersionId: undefined,
		})
		expect(readProject({ id: 'project', tagList: ['keep', 4], mode: 'FUTURE' })).toEqual({
			id: 'project',
			name: '',
			status: undefined,
			mode: undefined,
		})
		expect(readIntegrationToken({ token: 'secret', projects: [null, { projectId: 'p', roleCode: 'ADMIN' }] })).toEqual({
			id: '',
			name: '',
			token: 'secret',
			roleCode: undefined,
			projects: [{ projectId: '', roleCode: undefined }, { projectId: 'p', roleCode: 'ADMIN' }],
		})
	})

	test('strict environment reads ignore inherited optional fields but reject own undefined and duplicate identities', () => {
		const inherited: unknown = Object.assign(
			Object.create({ id: 'record', key: 'KEY', content: 'value', serviceStackId: 'foreign', sensitive: true }),
			{},
		)
		expect(parseServiceEnvResponse({ items: [inherited] }, 'service')).toEqual([{ id: 'record', key: 'KEY', content: 'value' }])
		for (const optional of ['serviceStackId', 'type', 'sensitive']) {
			expect(() => parseServiceEnvResponse({ items: [{ id: 'record', key: 'KEY', content: 'value', [optional]: undefined }] }, 'service'))
				.toThrow('invalid service environment response')
		}
		expect(() => parseServiceEnvResponse({ items: [{ id: 'r', key: 'A', content: '' }, { id: 'r', key: 'B', content: '' }] }, 'service'))
			.toThrow('invalid service environment response')
	})

	test('manifest authoring retains inherited fields, optional omission and shared pipeline/permission arrays', () => {
		const manifest = compileFabrikaManifest(
			{ id: 'app', target: { platform: 'zerops', services: () => [{ hostname: 'api', type: 'alpine/bun@1.3' }] } },
			'prod',
			SOURCE_DESCRIPTOR,
		)
		const permissions = ['read']
		const schema = {
			scopes: [Object.create({ type: 'item', label: undefined, extension: true })],
			actions: [{ action: 'read', description: undefined }],
			roles: { reader: { name: 'Reader', permissions, description: undefined } },
		}
		const parsed = parseFabrikaManifest({
			...manifest,
			app: { ...manifest.app, schema },
			target: {
				...manifest.target,
				proxy: { upstream: 'api:3000', gates: { rules: [Object.create({ path: '/*', kind: 'service', credential: undefined })] } },
			},
		})
		expect(parsed.app.pipeline.vars).toBe(manifest.app.pipeline.vars)
		expect(parsed.app.schema?.roles['reader']?.permissions).toBe(permissions)
		expect(parsed.app.schema).toEqual({
			scopes: [{ type: 'item' }],
			actions: [{ action: 'read' }],
			roles: { reader: { name: 'Reader', permissions: ['read'] } },
		})
		expect(parsed.target.proxy?.gates.rules).toEqual([{ path: '/*', kind: 'service' }])
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, proxy: { upstream: 'api:3000', gates: { rules: [{ path: '/*', kind: 'service', credential: null }] } } },
			})
		)
			.toThrow('proxy declaration')
	})

	test('descriptor structural parsing retains extension order and prototype-named JSON keys', () => {
		const source =
			'extension: retained\nzerops:\n  - extra: first\n    setup: api\n    run:\n      start: "bun index.ts"\n      envVariables:\n        __proto__: literal\n'
		const parsed = parseZeropsDescriptor(source)
		expect(Object.keys(parsed.document)).toEqual(['extension', 'zerops'])
		expect(JSON.stringify(parsed.document)).toBe(
			'{"extension":"retained","zerops":[{"extra":"first","setup":"api","run":{"start":"bun index.ts","envVariables":{"__proto__":"literal"}}}]}',
		)
		expect(prepareZeropsDescriptor(source).contents).toBe(source)
	})

	test('runtime source coordinates remain broader than source-service GitHub coordinates', () => {
		const decoded = zeropsTargetCodec.decode({
			projectId: 'project',
			serviceId: 'service',
			accessToken: 'token',
			source: { runId: 'run with spaces', repository: { owner: 'owner with spaces', name: 'name with spaces' }, commitSha: 'a'.repeat(40) },
		})
		expect(decoded.source?.repository).toEqual({ owner: 'owner with spaces', name: 'name with spaces' })
		expect(Object.hasOwn(decoded.source ?? {}, 'githubInstallationId')).toBe(false)
		expect(Object.keys(decoded)).toEqual(['projectId', 'serviceId', 'accessToken', 'source'])
	})

	test('namespace targets strip extensions while nested source records stay strict', () => {
		expect(zeropsNamespaceTargetCodec.decode({ extension: true, postgres: { type: 'postgresql:single@18', extension: true } })).toEqual({
			postgres: { type: 'postgresql:single@18' },
		})
		const source = {
			repository: { owner: 'owner', name: 'repo' },
			commitSha: 'a'.repeat(40),
			descriptor: { path: 'zerops.yaml', contents: 'zerops: [{setup: proxy}]', sha256: 'b'.repeat(64) },
		} satisfies ZeropsNamespaceProxySource
		expect(decodeZeropsNamespaceProxySource(source)).toEqual(source)
		expect(() => decodeZeropsNamespaceProxySource({ ...source, extension: true })).toThrow('unknown field')
		expect(() =>
			zeropsNamespaceTargetCodec.decode({
				proxyBuild: { runId: 'run', appVersionId: 'version', source, phase: 'source_uploaded', processId: 'process' },
			})
		)
			.toThrow()
	})

	test('managed serialization keeps canonical field order and rejects hidden/prototyped records', () => {
		const parsed = parseManagedOwner(owner)
		expect(serializeManagedOwner(parsed)).toBe(
			'{"protocol":1,"appId":"app","environment":"prod","namespaceId":"namespace","projectId":"project","serviceId":"service","hostname":"api"}',
		)
		for (
			const value of [Object.create(owner), Object.defineProperty({ ...owner }, 'hidden', { value: 'secret' }), {
				...owner,
				[Symbol('hidden')]: 'secret',
			}]
		) {
			expect(() => parseManagedOwner(value)).toThrow('invalid managed-environment protocol data')
		}
		const checkpoint = {
			...owner,
			runId: 'run',
			appVersionId: 'version',
			markerRecordId: 'marker',
			originalArtifactSha256: 'a'.repeat(64),
			descriptorSha256: 'b'.repeat(64),
			setup: 'api',
			sourceCommitSha: 'c'.repeat(40),
			phase: 'build_triggered',
			binding: mapManagedKeys(() => ({ state: 'absent' })),
		}
		expect(Object.keys(parseManagedCheckpoint(checkpoint))).toEqual([
			'protocol',
			'appId',
			'environment',
			'namespaceId',
			'projectId',
			'serviceId',
			'hostname',
			'runId',
			'appVersionId',
			'markerRecordId',
			'originalArtifactSha256',
			'descriptorSha256',
			'setup',
			'sourceCommitSha',
			'phase',
			'binding',
		])
		expect(() => parseManagedCheckpoint({ ...checkpoint, processId: undefined })).toThrow('invalid managed-environment protocol data')
	})
})
