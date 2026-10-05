import { describe, expect, test } from 'bun:test'
import { catalogIngestSchema, parseBrowserFixtures, parseBrowserIdentity } from '../browser-fixture-schemas'
import {
	alertsFixtureSchema,
	healthCheckFixtureSchema,
	healthFixtureSchema,
	idResponseSchema,
	machineKeyResponseSchema,
	rpcResponseSchema,
} from '../response-schemas'
import { environmentViewSchema, issueListSchema, managedSnapshotSchema } from '../smoke-schemas'
import { createZeropsEmulator } from '../zerops-emulator'
import { emptySnapshot, type EmulatorSnapshot } from '../zerops-emulator/model'
import { parseImportDocument, readSnapshot } from '../zerops-emulator/parsing'
import { parseSnapshot } from '../zerops-emulator/snapshot'

describe('legacy emulator snapshots', () => {
	test('recovers pre-process snapshots and preserves recovery normalization and omission', async () => {
		const state = await readSnapshot(`${import.meta.dir}/fixtures/legacy-emulator.json`)
		expect(state).toEqual({
			...emptySnapshot(),
			nextProject: 2,
			nextService: 2,
			nextEnv: 2,
			nextVersion: 2,
			projects: [{ id: 'p', clientId: 'c', name: 'legacy', mode: 'LIGHT', status: 'ACTIVE' }],
			services: [{ id: 's', projectId: 'p', name: 'api', status: 'ACTIVE', subdomainAccess: false }],
			serviceEnv: [{ id: 'e', serviceStackId: 's', key: 'VALUE', content: '', type: 'SECRET' }],
			appVersions: [{ id: 'v', serviceStackId: 's', projectId: 'p', status: 'BUILDING', sequence: 1 }],
		})
		expect(state.projects[0]).not.toHaveProperty('description')
		expect(state.projects[0]).not.toHaveProperty('tagList')
		expect(state.services[0]).not.toHaveProperty('base')
		expect(state.appVersions[0]).not.toHaveProperty('activateAt')
		expect(await readSnapshot(undefined)).toEqual(emptySnapshot())
	})

	test('retains current processes, grants without invented roles, and pending activation', () => {
		const snapshot: EmulatorSnapshot = {
			...emptySnapshot(),
			appVersions: [{ id: 'v', projectId: 'p', serviceStackId: 's', status: 'BUILDING', sequence: 2, activateAt: 0 }],
			processes: [{ id: 'process', actionName: 'stack.deploy', pendingReads: 0, serviceStackId: 's' }],
			integrationTokens: [{
				id: 't',
				clientId: 'c',
				name: '',
				created: 'then',
				lastUpdate: 'now',
				projects: [{ projectId: 'p' }, { projectId: 'q', roleCode: 'READ_ONLY' }],
			}],
		}
		const parsed = parseSnapshot(snapshot)
		expect(parsed).toEqual(snapshot)
		expect(parsed.integrationTokens[0]?.projects[0]).not.toHaveProperty('roleCode')
	})

	test('rejects malformed counters, records and present-but-invalid legacy additions', () => {
		for (
			const patch of [
				{ nextProject: 0 },
				{ nextService: 1.5 },
				{ nextIntegrationToken: null },
				{ projects: null },
				{ processes: null },
				{ integrationTokens: {} },
				{ services: [{ id: 3, projectId: 'p', name: 's' }] },
				{ projects: [{ id: 'p', clientId: 'c', name: 'p', mode: 'UNKNOWN' }] },
				{ processes: [{ id: 'p', actionName: 'stack.deploy', pendingReads: -1 }] },
				{ appVersions: [{ id: 'v', projectId: 'p', serviceStackId: 's', status: 'ACTIVE', sequence: 1, activateAt: -1 }] },
				{
					integrationTokens: [{ id: 't', clientId: 'c', name: 't', created: '', lastUpdate: '', projects: [{ projectId: 'p', roleCode: 'SUPERADMIN' }] }],
				},
			]
		) expect(() => parseSnapshot({ ...emptySnapshot(), ...patch })).toThrow()
	})

	test('round-trips upload tombstones and expanded version states without weakening legacy decoding', () => {
		const statuses: EmulatorSnapshot['appVersions'][number]['status'][] = ['UPLOADING', 'BUILDING', 'ACTIVE', 'BACKUP', 'BUILD_FAILED', 'CANCELLED']
		const snapshot: EmulatorSnapshot = {
			...emptySnapshot(),
			serviceEnv: [{ id: 'e', serviceStackId: 's', key: 'VALUE', content: 'x', type: 'USER', sensitive: false }],
			appVersions: statuses.map((status, index) => ({
				id: `v${index}`,
				projectId: 'p',
				serviceStackId: 's',
				status,
				sequence: index + 1,
				hasHttpPorts: false,
			})),
			uploadGrants: [{
				appVersionId: 'gone',
				capabilitySha256: 'a'.repeat(64),
				deleted: true,
				receipt: { compressedBytes: 10, compressedSha256: 'b'.repeat(64) },
			}],
		}
		expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
		const version: EmulatorSnapshot['appVersions'][number] = {
			id: 'managed',
			projectId: 'p',
			serviceStackId: 's',
			status: 'BUILDING',
			sequence: 1,
			managedRuntimeReferences: [{ key: 'FABRIKA_RELEASE', content: `\${FABRIKA_MENV_${'a'.repeat(48)}_R}` }],
		}
		expect(parseSnapshot({ ...emptySnapshot(), appVersions: [version] }).appVersions).toEqual([version])
		for (
			const references of [
				[{ key: 'APP_LABEL', content: `\${FABRIKA_MENV_${'a'.repeat(48)}_R}` }],
				[{ key: 'FABRIKA_RELEASE', content: 'expanded-secret-value' }],
				[...version.managedRuntimeReferences ?? [], ...version.managedRuntimeReferences ?? []],
			]
		) expect(() => parseSnapshot({ ...emptySnapshot(), appVersions: [{ ...version, managedRuntimeReferences: references }] })).toThrow()
		for (
			const grant of [
				{ appVersionId: 'v', capabilitySha256: 'invalid', deleted: false },
				{ appVersionId: 'v', capabilitySha256: 'a'.repeat(64), deleted: false, capability: 'secret' },
				{ appVersionId: 'v', capabilitySha256: 'a'.repeat(64), deleted: false, receipt: { compressedBytes: 0, compressedSha256: 'b'.repeat(64) } },
			]
		) expect(() => parseSnapshot({ ...emptySnapshot(), uploadGrants: [grant] })).toThrow()
	})
})

describe('emulator request boundaries', () => {
	test('keeps tolerant YAML fields and ignores extensions without inventing options', () => {
		const result = parseImportDocument(`project:
  name: legacy
  tags: [valid, 2]
  description: 1
  extension: {opaque: true}
services:
  - hostname: api
    type: 42
    override: false
    startWithoutCode: wrong
    enableSubdomainAccess: true
    extension: {opaque: true}
`)
		expect(result).toEqual({ project: { name: 'legacy' }, services: [{ hostname: 'api', override: false }] })
		expect(result.services[0]).not.toHaveProperty('type')
		expect(() => parseImportDocument('services: [{hostname: api, zeropsSetup: build}]')).toThrow('parameter is required for use of pipelineConfig')
	})

	test('auth and resource lookup precede malformed JSON; request errors retain their envelopes', async () => {
		const handler = await createZeropsEmulator({ token: 'test' })
		const send = (path: string, body: string, token = 'test') =>
			handler(
				new Request(`http://emulator${path}`, {
					method: 'POST',
					headers: { authorization: `Bearer ${token}` },
					body,
				}),
			)
		const denied = await send('/client/c/project/import', '{', 'wrong')
		expect(denied.status).toBe(401)
		expect(await denied.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'invalid bearer token' } })
		const missing = await send('/project/missing/service-stack/import', '{')
		expect(missing.status).toBe(404)
		for (
			const [body, message] of [['{', 'request body must be JSON'], ['null', 'invalid state field yaml'], ['{"yaml":3}', 'invalid state field yaml']]
		) {
			const response = await send('/client/c/project/import', body ?? '')
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: { code: 'BAD_REQUEST', message } })
		}
	})

	test('keeps user-data refusal order and accepts opaque request extensions', async () => {
		const handler = await createZeropsEmulator({ token: 'test' })
		const send = (path: string, body: unknown, method = 'POST') =>
			handler(
				new Request(`http://emulator${path}`, {
					method,
					headers: { authorization: 'Bearer test' },
					body: JSON.stringify(body),
				}),
			)
		expect((await send('/client/c/project/import', { yaml: 'project: {name: local}\nservices: [{hostname: api}]', extra: [1] })).status).toBe(200)
		const path = '/service-stack/service-000001/user-data'
		for (
			const [body, expected] of [
				[{}, { code: 'BAD_REQUEST', message: 'invalid state field key' }],
				[{ key: 'ZEROPS_X' }, { code: 'invalidUserInput', message: 'sensitive: field is required' }],
				[{ key: 'X', sensitive: false }, { code: 'BAD_REQUEST', message: 'invalid state field content' }],
			]
		) {
			const response = await send(path, body)
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: expected })
		}
		expect((await send(path, { key: 'X', content: '', sensitive: false, extension: { opaque: true } })).status).toBe(200)
		const update = await send('/user-data/env-000002', { sensitive: false }, 'PUT')
		expect(await update.json()).toEqual({ error: { code: 'invalidUserInput', message: 'key and content are both required' } })
		const token = await send('/client/c/integration-token', { name: 'label', projects: [{ projectId: 'p', extension: true }], extra: true })
		expect(token.status).toBe(201)
		expect(await token.json()).toMatchObject({ projects: [{ projectId: 'p' }], name: 'label' })
		const invalid = await send('/client/c/integration-token', { name: 'label', projects: [{ projectId: 'p', roleCode: 'wrong' }] })
		expect(await invalid.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'unknown roleCode in the integration token grant for p' } })
	})
})

describe('fixture and smoke response parsing', () => {
	test('retains browser identity bytes and source coordinates without accepting malformed fixtures', () => {
		const roles: ('admin' | 'operations-notes')[] = ['admin', 'operations-notes']
		for (const role of roles) {
			const identity = { role, principalId: 'principal', label: 'Browser user', session: 'opaque-session', expiresAt: 123 }
			expect(parseBrowserIdentity({ ...identity, extension: true })).toEqual(identity)
		}
		expect(() => parseBrowserIdentity({ role: 'other' })).toThrow('browser identity has an invalid role')
		expect(() => parseBrowserIdentity({ role: '' })).toThrow('browser fixture is missing role')
		expect(() => parseBrowserIdentity({ role: 'admin', principalId: '' })).toThrow('browser fixture is missing principalId')
		const visible = {
			appId: 'browser-notes',
			environment: 'test',
			serviceKey: 'default',
			displayName: 'Browser Notes / test',
			credentialId: 'credential',
			publicKey: 'key',
			ingestProjectId: '123',
			release: { name: 'release', runId: 'run', uploadBearer: 'opaque-bearer' },
		}
		const hidden = { ...visible, appId: 'browser-hidden', environment: 'secret' }
		expect(parseBrowserFixtures({ version: 1, visible: { ...visible, nextRelease: {} }, hidden })).toEqual({ version: 1, visible, hidden })
		expect(() => parseBrowserFixtures({ version: 2, visible, hidden })).toThrow('unsupported version')
		expect(() => parseBrowserFixtures({ version: 1, visible: { ...visible, release: {} }, hidden })).toThrow('browser fixture is missing name')
		expect(
			catalogIngestSchema.parse({
				ingest: [{
					coordinate: { appId: 'browser-notes', environment: 'test', serviceKey: 'default', extra: true },
					credentialId: 'c',
					ingestProjectId: 'p',
				}],
			}).ingest[0]?.coordinate,
		).toEqual({ appId: 'browser-notes', environment: 'test', serviceKey: 'default' })
		expect(catalogIngestSchema.safeParse({ ingest: [{ coordinate: null }] }).success).toBe(false)
	})

	test('filters unrelated rows but still rejects malformed selected identifiers', () => {
		const health = healthFixtureSchema.parse({ httpChecks: [null, 2, { path: '/other' }, { path: '/healthz', id: '' }] })
		const checks = health.httpChecks.map((entry) => healthCheckFixtureSchema.safeParse(entry))
		const selected = checks.find((entry) => entry.success && entry.data.path === '/healthz')
		expect(selected?.success).toBe(true)
		expect(idResponseSchema.safeParse(selected?.success ? selected.data : undefined).success).toBe(false)
		expect(healthFixtureSchema.parse(null)).toEqual({ httpChecks: [] })
		expect(alertsFixtureSchema.parse({ channels: 'invalid' })).toEqual({ channels: [] })
		const issues = issueListSchema.parse({ items: [null, { title: 2 }, { title: 'marker', id: 'issue', count: 3 }] })
		expect(issues.items.filter((issue) => issue.title?.includes('marker'))).toEqual([{ title: 'marker', id: 'issue', count: 3, source: {} }])
		expect(issueListSchema.safeParse({ items: null }).success).toBe(false)
	})

	test('preserves opaque provider payloads and rejects invalid machine/RPC outputs', () => {
		const target = { provider: 'future', payload: { arbitrary: [null, 1, { deeply: true }] } }
		const artifact = { extension: ['unchanged'] }
		const parsed = environmentViewSchema.parse({ env: 'prod', target, artifact })
		expect(parsed.target).toBe(target)
		expect(parsed.artifact).toBe(artifact)
		expect(machineKeyResponseSchema.parse({ apiKey: 'px_bytes', principalId: 'ignored' })).toEqual({ apiKey: 'px_bytes' })
		for (const value of [null, {}, { apiKey: '' }, { apiKey: 1 }]) expect(machineKeyResponseSchema.safeParse(value).success).toBe(false)
		const result = { arbitrary: true }
		expect(rpcResponseSchema.parse({ result }).result).toBe(result)
		expect(rpcResponseSchema.safeParse({ error: null, result }).success).toBe(false)
		expect(managedSnapshotSchema.parse({ services: [null, { name: 'other' }], serviceEnv: [null] })).toEqual({
			services: [{}, { name: 'other' }],
			serviceEnv: [{}],
		})
	})
})
