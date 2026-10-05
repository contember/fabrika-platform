import { createZeropsApi, type FetchLike, waitForProcess } from '@fabrika/provider-zerops'
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { admitManagedEnvironment, confirmCodelessManagedService } from '../../../../provider-zerops/src/managed-environment/admission'
import { MANAGED_ENVIRONMENT_MARKER, type ManagedOwner, serializeManagedMarker } from '../../../../provider-zerops/src/managed-environment/protocol'
import {
	LOCAL_SOURCE_EMULATOR_ORIGIN,
	LOCAL_SOURCE_MAX_COMPRESSED_BYTES,
	LOCAL_SOURCE_UPLOAD_PATH,
	LOCAL_SOURCE_UPLOAD_URL,
	parseLocalSourceUploadSearch,
} from '../../local-source-contract'
import { createZeropsEmulator, type ZeropsEmulatorOptions } from '../../zerops-emulator'
import { parseSnapshot } from '../../zerops-emulator/snapshot'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const signal = () => AbortSignal.timeout(5_000)
const descriptor = 'zerops:\n  - setup: api\n    run:\n      ports:\n        - port: 3000\n          httpSupport: true\n'
const bytes = Bun.gzipSync(new TextEncoder().encode('synthetic transport bytes; the emulator does not unpack or build them'))

async function client(options: Partial<ZeropsEmulatorOptions> = {}) {
	const handler = await createZeropsEmulator({ token: 'test', ...options })
	const fetchImpl: FetchLike = (input, init) => handler(new Request(input, init))
	const api = createZeropsApi({ token: 'test', baseUrl: `${LOCAL_SOURCE_EMULATOR_ORIGIN}/api/rest/public`, fetchImpl, sleep: async () => {} })
	const state = async () =>
		parseSnapshot(
			await (await handler(new Request(`${LOCAL_SOURCE_EMULATOR_ORIGIN}/__local/state`, { headers: { authorization: 'Bearer test' } }))).json(),
		)
	const upload = (uploadUrl: string, body: BodyInit = bytes, init: RequestInit = {}) =>
		handler(new Request(LOCAL_SOURCE_EMULATOR_ORIGIN + LOCAL_SOURCE_UPLOAD_PATH + new URL(uploadUrl).search, { method: 'PUT', body, ...init }))
	return { api, handler, state, upload }
}

async function fixture(options: Partial<ZeropsEmulatorOptions> = {}) {
	const result = await client(options)
	const imported = await result.api.importProject({
		clientId: 'client',
		yaml: 'project: {name: local}\nservices: [{hostname: api, override: false, startWithoutCode: true}]',
		signal: signal(),
	})
	const service = imported.services[0]
	if (service === undefined) throw new Error('missing service')
	return { ...result, imported, serviceId: service.id }
}

async function stateFile() {
	const directory = await mkdtemp('/tmp/opencode/immutable-source-emulator-')
	directories.push(directory)
	return `${directory}/state.json`
}

test('real client reserves exactly one version, persists a hash-only grant and receipt, and activates it after restart', async () => {
	const path = await stateFile()
	let now = 100
	const f = await fixture({ stateFile: path, activationDelayMs: 100, now: () => now })
	const previous = (await f.api.getService({ serviceId: f.serviceId, signal: signal() })).activeAppVersionId
	const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	expect(reservation.uploadUrl.startsWith(`${LOCAL_SOURCE_UPLOAD_URL}?`)).toBe(true)
	const capability = parseLocalSourceUploadSearch(new URL(reservation.uploadUrl).search)
	expect((await f.api.getAppVersion({ appVersionId: reservation.id, signal: signal() })).status).toBe('UPLOADING')
	expect((await f.upload(reservation.uploadUrl)).status).toBe(200)
	const snapshot = await f.state()
	expect(snapshot.uploadGrants).toEqual([{
		appVersionId: reservation.id,
		capabilitySha256: createHash('sha256').update(capability.capability).digest('hex'),
		deleted: false,
		receipt: { compressedBytes: bytes.length, compressedSha256: createHash('sha256').update(bytes).digest('hex') },
	}])
	expect(JSON.stringify(snapshot)).not.toContain(capability.capability)
	expect(await Bun.file(path).text()).not.toContain(capability.capability)
	const restored = await client({ stateFile: path, activationDelayMs: 100, now: () => now })
	expect(await restored.state()).toEqual(snapshot)
	const process = await restored.api.buildAndDeployAppVersion({
		appVersionId: reservation.id,
		zeropsYaml: descriptor,
		zeropsYamlSetup: 'api',
		signal: signal(),
	})
	expect(process.appVersionId).toBe(reservation.id)
	expect((await restored.api.getAppVersion({ appVersionId: reservation.id, signal: signal() })).status).toBe('BUILDING')
	expect((await restored.api.getService({ serviceId: f.serviceId, signal: signal() })).activeAppVersionId).toBe(previous)
	now = 200
	const restarted = await client({ stateFile: path, now: () => now })
	expect((await restarted.api.getAppVersion({ appVersionId: reservation.id, signal: signal() })).status).toBe('ACTIVE')
	expect((await restarted.api.getAppVersion({ appVersionId: previous ?? '', signal: signal() })).status).toBe('BACKUP')
	expect((await restarted.state()).appVersions).toHaveLength(2)
	expect((await restarted.state()).processes.filter((entry) => entry.actionName === 'stack.build')).toHaveLength(1)
})

test('a held upload finishing after deletion and after restart cannot resurrect or activate its version', async () => {
	const path = await stateFile()
	const f = await fixture({ stateFile: path })
	const active = (await f.api.getService({ serviceId: f.serviceId, signal: signal() })).activeAppVersionId
	const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	const stream = new TransformStream<Uint8Array, Uint8Array>()
	const writer = stream.writable.getWriter()
	const pending = f.upload(reservation.uploadUrl, stream.readable)
	await writer.write(bytes)
	expect((await f.state()).uploadGrants[0]?.receipt).toBeUndefined()
	expect((await f.upload(reservation.uploadUrl)).status).toBe(409)
	await f.api.deleteAppVersion({ appVersionId: reservation.id, signal: signal() })
	await writer.close()
	expect((await pending).status).toBe(200)
	const restarted = await client({ stateFile: path })
	expect((await restarted.upload(reservation.uploadUrl)).status).toBe(200)
	for (const method of ['GET', 'DELETE', 'PUT']) {
		const suffix = method === 'PUT' ? '/build-and-deploy' : ''
		const response = await restarted.handler(
			new Request(`${LOCAL_SOURCE_EMULATOR_ORIGIN}/app-version/${reservation.id}${suffix}`, { method, headers: { authorization: 'Bearer test' } }),
		)
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({ error: { code: 'appVersionNotFound' } })
	}
	expect((await restarted.state()).uploadGrants[0]?.deleted).toBe(true)
	expect((await restarted.api.getService({ serviceId: f.serviceId, signal: signal() })).activeAppVersionId).toBe(active)
	expect((await restarted.state()).appVersions).toHaveLength(1)
})

test('receipt publication requires bounded nonempty EOF; failed and conflicting retries preserve prior receipt', async () => {
	const f = await fixture()
	const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	const broken = () =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes)
				controller.error(new Error('private transport detail'))
			},
		})
	for (const body of ['', new Uint8Array(LOCAL_SOURCE_MAX_COMPRESSED_BYTES + 1), broken()]) {
		expect((await f.upload(reservation.uploadUrl, body)).status).toBe(400)
		expect((await f.state()).uploadGrants[0]?.receipt).toBeUndefined()
	}
	const abort = new AbortController()
	const stream = new TransformStream<Uint8Array, Uint8Array>()
	const writer = stream.writable.getWriter()
	const pending = f.upload(reservation.uploadUrl, stream.readable, { signal: abort.signal })
	await writer.write(bytes)
	abort.abort()
	expect((await pending).status).toBe(400)
	expect((await f.state()).uploadGrants[0]?.receipt).toBeUndefined()
	expect((await f.upload(reservation.uploadUrl)).status).toBe(200)
	const receipt = (await f.state()).uploadGrants[0]?.receipt
	expect((await f.upload(reservation.uploadUrl)).status).toBe(200)
	expect((await f.upload(reservation.uploadUrl, 'different')).status).toBe(409)
	expect((await f.upload(reservation.uploadUrl, broken())).status).toBe(400)
	expect((await f.state()).uploadGrants[0]?.receipt).toEqual(receipt)
})

test('capability bypass is confined to canonical private PUT without PAT; no production endpoint bypass', async () => {
	const f = await fixture()
	const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	const second = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	const search = new URL(reservation.uploadUrl).search
	const destination = LOCAL_SOURCE_EMULATOR_ORIGIN + LOCAL_SOURCE_UPLOAD_PATH
	for (
		const url of [
			destination + search + '&extra=x',
			destination + search + '&localVersion=1',
			destination + search.replace('localVersion=1', 'localVersion=2'),
			destination + search.replace(reservation.id, second.id),
		]
	) {
		expect((await f.handler(new Request(url, { method: 'PUT', body: bytes }))).ok).toBe(false)
	}
	expect((await f.upload(reservation.uploadUrl, bytes, { headers: { authorization: 'Bearer test' } })).status).toBe(400)
	expect((await f.handler(new Request(reservation.uploadUrl, { method: 'PUT', body: bytes }))).status).toBe(401)
	expect(
		(await f.handler(
			new Request(`${LOCAL_SOURCE_EMULATOR_ORIGIN}/api/rest/public${LOCAL_SOURCE_UPLOAD_PATH}${search}`, { method: 'PUT', body: bytes }),
		)).status,
	).toBe(401)
	expect((await f.handler(new Request(destination + search))).status).toBe(400)
	expect((await f.state()).uploadGrants.every((entry) => entry.receipt === undefined)).toBe(true)
})

test('missing-upload build accepts submission and records a labeled synthetic failure without changing active version', async () => {
	const f = await fixture()
	const active = (await f.api.getService({ serviceId: f.serviceId, signal: signal() })).activeAppVersionId
	const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	const process = await f.api.buildAndDeployAppVersion({ appVersionId: reservation.id, zeropsYaml: descriptor, signal: signal() })
	expect(process.appVersionId).toBe(reservation.id)
	expect((await f.api.getAppVersion({ appVersionId: reservation.id, signal: signal() })).status).toBe('BUILD_FAILED')
	expect((await f.state()).appVersions.find((entry) => entry.id === reservation.id)?.syntheticFailure).toBe('LOCAL_MISSING_UPLOAD')
	expect((await f.api.getService({ serviceId: f.serviceId, signal: signal() })).activeAppVersionId).toBe(active)
})

test('deleting the service tombstones its reservations; non-HTTP builds never enable a subdomain', async () => {
	const f = await fixture()
	const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	await f.upload(reservation.uploadUrl)
	await f.api.buildAndDeployAppVersion({
		appVersionId: reservation.id,
		zeropsYaml: descriptor.replace('httpSupport: true', 'httpSupport: false'),
		signal: signal(),
	})
	expect((await f.api.getAppVersion({ appVersionId: reservation.id, signal: signal() })).status).toBe('ACTIVE')
	await expect(f.api.enableSubdomainAccess({ serviceId: f.serviceId, signal: signal() })).rejects.toThrow('serviceStackIsNotHttp')
	const deletion = await f.handler(
		new Request(`${LOCAL_SOURCE_EMULATOR_ORIGIN}/service-stack/${f.serviceId}`, {
			method: 'DELETE',
			headers: { authorization: 'Bearer test' },
		}),
	)
	expect(deletion.status).toBe(200)
	expect((await f.upload(reservation.uploadUrl)).status).toBe(200)
	expect((await f.state()).uploadGrants[0]?.deleted).toBe(true)
	expect((await f.state()).appVersions).toEqual([])
	await expect(f.api.getAppVersion({ appVersionId: reservation.id, signal: signal() })).rejects.toThrow('appVersionNotFound')
})

test('codeless evidence and sensitive USER records pass real managed admission; codeless reimport demotes HTTP version', async () => {
	const f = await fixture()
	const owner: ManagedOwner = {
		protocol: 1,
		appId: 'demo',
		environment: 'test',
		namespaceId: 'namespace',
		projectId: f.imported.projectId,
		serviceId: f.serviceId,
		hostname: 'api',
	}
	const finishedProcesses = await Promise.all(
		f.imported.services.flatMap((entry) => entry.processes).map((process) =>
			waitForProcess({ api: f.api, processId: process.id, signal: signal(), sleep: async () => {} })
		),
	)
	const service = await f.api.getService({ serviceId: f.serviceId, signal: signal() })
	const evidence = confirmCodelessManagedService({
		owner,
		provisioningDocument: { services: [{ hostname: 'api', override: false, startWithoutCode: true }] },
		imported: f.imported,
		finishedProcesses,
		service,
	})
	await f.api.putServiceEnv({
		serviceId: f.serviceId,
		key: MANAGED_ENVIRONMENT_MARKER,
		value: serializeManagedMarker({
			...owner,
			creationProcessId: evidence.creationProcessId,
			initialCodelessAppVersionId: evidence.codelessAppVersionId,
		}),
		signal: signal(),
	})
	const records = await f.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })
	expect(records[0]).toMatchObject({ type: 'USER', sensitive: true })
	await expect(
		admitManagedEnvironment({ owner, records, observedActiveAppVersionId: service.activeAppVersionId ?? null, prior: { kind: 'bootstrap' } }),
	).resolves.toHaveProperty('markerRecordId')
	await expect(f.api.enableSubdomainAccess({ serviceId: f.serviceId, signal: signal() })).rejects.toThrow('serviceStackIsNotHttp')
	const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	await f.upload(reservation.uploadUrl)
	await f.api.buildAndDeployAppVersion({ appVersionId: reservation.id, zeropsYaml: descriptor, signal: signal() })
	await f.api.enableSubdomainAccess({ serviceId: f.serviceId, signal: signal() })
	await f.api.importServices({
		projectId: f.imported.projectId,
		yaml: 'services: [{hostname: api, override: true, startWithoutCode: true}]',
		signal: signal(),
	})
	expect((await f.api.getAppVersion({ appVersionId: reservation.id, signal: signal() })).status).toBe('BACKUP')
	await expect(f.api.enableSubdomainAccess({ serviceId: f.serviceId, signal: signal() })).rejects.toThrow('serviceStackIsNotHttp')
})
