import { createZeropsApi, type FetchLike, waitForProcess } from '@fabrika/provider-zerops'
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { admitManagedEnvironment, confirmCodelessManagedService } from '../../../../provider-zerops/src/managed-environment/admission'
import { prepareManagedDescriptor } from '../../../../provider-zerops/src/managed-environment/descriptor'
import {
	MANAGED_ENVIRONMENT_MARKER,
	type ManagedCheckpoint,
	type ManagedOwner,
	managedReferenceNames,
	mapManagedKeys,
	serializeManagedMarker,
} from '../../../../provider-zerops/src/managed-environment/protocol'
import {
	LOCAL_SOURCE_EMULATOR_ORIGIN,
	LOCAL_SOURCE_MAX_COMPRESSED_BYTES,
	LOCAL_SOURCE_UPLOAD_PATH,
	LOCAL_SOURCE_UPLOAD_URL,
	parseLocalSourceUploadSearch,
} from '../../local-source-contract'
import { createZeropsEmulator, type ZeropsEmulatorOptions } from '../../zerops-emulator'
import { emptySnapshot, type EmulatorSnapshot } from '../../zerops-emulator/model'
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

test('managed second-deploy admission follows activated references, preserving the previous version while pending and across restart', async () => {
	const path = await stateFile()
	let now = 100
	const f = await fixture({ stateFile: path, activationDelayMs: 100, now: () => now })
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
	const marker = (await f.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })).find((entry) => entry.key === MANAGED_ENVIRONMENT_MARKER)
	if (marker === undefined) throw new Error('missing marker')
	const stage = async (release: string, withDsn: boolean) => {
		const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
		const names = await managedReferenceNames({ ...owner, appVersionId: reservation.id })
		await f.api.putServiceEnv({ serviceId: f.serviceId, key: names.FABRIKA_RELEASE, value: release, signal: signal() })
		if (withDsn) await f.api.putServiceEnv({ serviceId: f.serviceId, key: names.FABRIKA_OPERATIONS_DSN, value: 'synthetic-dsn', signal: signal() })
		const records = await f.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })
		const checkpoint: ManagedCheckpoint = {
			...owner,
			runId: release,
			appVersionId: reservation.id,
			markerRecordId: marker.id,
			originalArtifactSha256: 'a'.repeat(64),
			descriptorSha256: 'b'.repeat(64),
			sourceCommitSha: 'c'.repeat(40),
			setup: 'api',
			phase: 'build_triggered',
			binding: mapManagedKeys((key) => {
				if (key !== 'FABRIKA_RELEASE' && !(withDsn && key === 'FABRIKA_OPERATIONS_DSN')) return { state: 'absent' }
				const record = records.find((entry) => entry.key === names[key])
				if (record === undefined) throw new Error('missing backing record')
				return { state: 'confirmed', referenceName: names[key], backingRecordId: record.id }
			}),
		}
		// The unselected setup and ordinary application variable are outside the modeled canonical references.
		const source = `${descriptor}      envVariables:\n        APP_LABEL: unmodeled\n`
		const prepared = prepareManagedDescriptor(source, 'api', checkpoint.binding)
		const selected = prepared.contents + '\n  - setup: other\n    run:\n      envVariables:\n        FABRIKA_RELEASE: unselected\n'
		await f.upload(reservation.uploadUrl)
		return { reservation, checkpoint, selected }
	}
	const first = await stage('release-a', true)
	await f.api.buildAndDeployAppVersion({ appVersionId: first.reservation.id, zeropsYaml: first.selected, zeropsYamlSetup: 'api', signal: signal() })
	now = 200
	const recordsA = await f.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })
	const admit = (api: typeof f.api, checkpoint: ManagedCheckpoint) =>
		Promise.all([
			api.listServiceEnv({ serviceId: f.serviceId, signal: signal() }),
			api.getService({ serviceId: f.serviceId, signal: signal() }),
		]).then(([records, current]) =>
			admitManagedEnvironment({
				owner,
				records,
				observedActiveAppVersionId: current.activeAppVersionId ?? null,
				prior: { kind: 'retained', checkpoint },
			})
		)
	await expect(admit(f.api, first.checkpoint)).resolves.toHaveProperty('markerRecordId', marker.id)
	expect(recordsA.find((entry) => entry.key === 'FABRIKA_RELEASE')).toMatchObject({ type: 'USER', sensitive: false })
	const second = await stage('release-b', false)
	const beforeSubmission = await f.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })
	await f.api.buildAndDeployAppVersion({ appVersionId: second.reservation.id, zeropsYaml: second.selected, zeropsYamlSetup: 'api', signal: signal() })
	expect(await f.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })).toEqual(beforeSubmission)
	await expect(admit(f.api, first.checkpoint)).resolves.toHaveProperty('markerRecordId', marker.id)
	const restarted = await client({ stateFile: path, now: () => now })
	expect(await restarted.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })).toEqual(beforeSubmission)
	await expect(admit(restarted.api, first.checkpoint)).resolves.toHaveProperty('markerRecordId', marker.id)
	now = 300
	await expect(admit(restarted.api, second.checkpoint)).resolves.toHaveProperty('markerRecordId', marker.id)
	const recordsB = await restarted.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })
	const binding = second.checkpoint.binding.FABRIKA_RELEASE
	if (binding.state !== 'confirmed') throw new Error('missing release binding')
	expect(recordsB.find((entry) => entry.key === 'FABRIKA_RELEASE')).toMatchObject({
		content: `\${${binding.referenceName}}`,
		type: 'USER',
		sensitive: false,
	})
	expect(recordsB.some((entry) => entry.key === 'FABRIKA_OPERATIONS_DSN')).toBe(false)
	expect(recordsB.some((entry) => entry.key === 'APP_LABEL')).toBe(false)
	expect(recordsB.find((entry) => entry.key === binding.referenceName)?.content).toBe('release-b')
	const firstBinding = first.checkpoint.binding.FABRIKA_RELEASE
	if (firstBinding.state !== 'confirmed') throw new Error('missing first release binding')
	expect(recordsB.find((entry) => entry.id === firstBinding.backingRecordId)).toEqual(
		recordsA.find((entry) => entry.id === firstBinding.backingRecordId),
	)
	const final = await client({ stateFile: path })
	await expect(admit(final.api, second.checkpoint)).resolves.toHaveProperty('markerRecordId', marker.id)
})

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

test('held build body cannot submit a deleted version or mutate the deletion snapshot', async () => {
	const path = await stateFile()
	const f = await fixture({ stateFile: path })
	const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	await f.upload(reservation.uploadUrl)
	const stream = new TransformStream<Uint8Array, Uint8Array>()
	const writer = stream.writable.getWriter()
	const pending = f.handler(
		new Request(`${LOCAL_SOURCE_EMULATOR_ORIGIN}/app-version/${reservation.id}/build-and-deploy`, {
			method: 'PUT',
			headers: { authorization: 'Bearer test' },
			body: stream.readable,
		}),
	)
	const body = new TextEncoder().encode(JSON.stringify({ zeropsYaml: descriptor }))
	await writer.write(body.subarray(0, 1))
	await f.api.deleteAppVersion({ appVersionId: reservation.id, signal: signal() })
	const deleted = await f.state()
	await writer.write(body.subarray(1))
	await writer.close()
	const response = await pending
	expect(response.status).toBe(400)
	expect(await response.json()).toMatchObject({ error: { code: 'appVersionNotFound' } })
	expect(await f.state()).toEqual(deleted)
	expect(await (await client({ stateFile: path })).state()).toEqual(deleted)
})

test('held reservation body cannot create an orphan version or grant after service deletion', async () => {
	const path = await stateFile()
	const f = await fixture({ stateFile: path })
	const stream = new TransformStream<Uint8Array, Uint8Array>()
	const writer = stream.writable.getWriter()
	const pending = f.handler(
		new Request(`${LOCAL_SOURCE_EMULATOR_ORIGIN}/service-stack/${f.serviceId}/app-version`, {
			method: 'POST',
			headers: { authorization: 'Bearer test' },
			body: stream.readable,
		}),
	)
	await writer.write(new TextEncoder().encode('{'))
	const deletion = await f.handler(
		new Request(`${LOCAL_SOURCE_EMULATOR_ORIGIN}/service-stack/${f.serviceId}`, {
			method: 'DELETE',
			headers: { authorization: 'Bearer test' },
		}),
	)
	expect(deletion.status).toBe(200)
	const deleted = await f.state()
	await writer.write(new TextEncoder().encode('}'))
	await writer.close()
	const response = await pending
	expect(response.status).toBe(400)
	expect(await response.json()).toMatchObject({ error: { code: 'serviceStackNotFound' } })
	expect(await f.state()).toEqual(deleted)
	expect(await (await client({ stateFile: path })).state()).toEqual(deleted)
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

test('a current state file with every record kind round-trips through JSON', () => {
	const snapshot: EmulatorSnapshot = {
		nextProject: 2,
		nextService: 2,
		nextEnv: 3,
		nextVersion: 3,
		nextProcess: 2,
		nextIntegrationToken: 2,
		projects: [{ id: 'p', clientId: 'c', name: 'local', status: 'ACTIVE', mode: 'LIGHT', description: 'd', tagList: ['t'] }],
		services: [{
			id: 's',
			projectId: 'p',
			name: 'api',
			status: 'ACTIVE',
			base: 'alpine',
			activeAppVersionId: 'v1',
			subdomainAccess: true,
			autoscalingProfileId: 'a',
		}],
		serviceEnv: [
			{ id: 'e1', serviceStackId: 's', key: 'SECRET_VALUE', content: 'x', type: 'SECRET' },
			{ id: 'e2', serviceStackId: 's', key: 'USER_VALUE', content: '', type: 'USER', sensitive: false },
		],
		appVersions: [
			{
				id: 'v1',
				serviceStackId: 's',
				projectId: 'p',
				status: 'ACTIVE',
				sequence: 1,
				hasHttpPorts: true,
				managedRuntimeReferences: [{ key: 'FABRIKA_RELEASE', content: `\${FABRIKA_MENV_${'a'.repeat(48)}_R}` }],
			},
			{ id: 'v2', serviceStackId: 's', projectId: 'p', status: 'BUILDING', sequence: 2, activateAt: 0, syntheticFailure: 'LOCAL_MISSING_UPLOAD' },
		],
		processes: [{ id: 'process', actionName: 'stack.build', serviceStackId: 's', projectId: 'p', appVersionId: 'v2', pendingReads: 1 }],
		integrationTokens: [{
			id: 't',
			clientId: 'c',
			name: 'token',
			created: 'then',
			lastUpdate: 'now',
			projects: [{ projectId: 'p' }, { projectId: 'q', roleCode: 'READ_ONLY' }],
			roleCode: 'ADMIN',
		}],
		uploadGrants: [
			{ appVersionId: 'v1', capabilitySha256: 'a'.repeat(64), deleted: false, receipt: { compressedBytes: 10, compressedSha256: 'b'.repeat(64) } },
			{ appVersionId: 'v2', capabilitySha256: 'c'.repeat(64), deleted: true },
		],
	}
	expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
})

test('the state file refuses an expanded managed value and a raw upload capability', () => {
	const version = { id: 'v', projectId: 'p', serviceStackId: 's', status: 'BUILDING', sequence: 1 }
	const references = [{ key: 'FABRIKA_RELEASE', content: 'expanded-secret-value' }]
	expect(() => parseSnapshot({ ...emptySnapshot(), appVersions: [{ ...version, managedRuntimeReferences: references }] })).toThrow(
		/^invalid Zerops emulator state at appVersions\.0\.managedRuntimeReferences\.0\.content: .*; run `bun run local:reset`$/,
	)
	const grant = { appVersionId: 'v', capabilitySha256: 'a'.repeat(64), deleted: false, capability: 'secret' }
	expect(() => parseSnapshot({ ...emptySnapshot(), uploadGrants: [grant] })).toThrow(
		/^invalid Zerops emulator state at uploadGrants\.0: .*; run `bun run local:reset`$/,
	)
})
