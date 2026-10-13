import { createZeropsApi, type FetchLike } from '@fabrika/provider-zerops'
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { overlayRelease } from '../../../../provider-zerops/src/managed-env'
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
	const directory = await mkdtemp(join(tmpdir(), 'immutable-source-emulator-'))
	directories.push(directory)
	return `${directory}/state.json`
}

test("the active version's literal run variables are listed by /env as USER records that refuse a write or a delete", async () => {
	const path = await stateFile()
	let now = 100
	const f = await fixture({ stateFile: path, activationDelayMs: 100, now: () => now })
	const deploy = async (release: string, label: string | null) => {
		const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
		const source = label === null ? descriptor : `${descriptor}      envVariables:\n        APP_LABEL: ${label}\n`
		const execution = overlayRelease(`${source}  - setup: other\n    run:\n      envVariables:\n        APP_LABEL: unselected\n`, 'api', release)
		await f.upload(reservation.uploadUrl)
		await f.api.buildAndDeployAppVersion({ appVersionId: reservation.id, zeropsYaml: execution.contents, zeropsYamlSetup: 'api', signal: signal() })
		return reservation
	}
	const envRecords = async (state: () => Promise<EmulatorSnapshot>) =>
		Object.fromEntries(
			(await state()).serviceEnv.filter((record) => record.serviceStackId === f.serviceId && record.type === 'ENV').map((
				record,
			) => [record.key, record.content]),
		)

	await deploy('release-a', 'a')
	now = 200
	expect((await f.api.getService({ serviceId: f.serviceId, signal: signal() })).activeAppVersionId).toBeDefined()
	expect(await envRecords(f.state)).toEqual({ APP_LABEL: 'a', FABRIKA_RELEASE: 'release-a' })
	const listed = await f.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })
	expect(listed.map(({ key, type }) => ({ key, type }))).toEqual([{ key: 'APP_LABEL', type: 'USER' }, { key: 'FABRIKA_RELEASE', type: 'USER' }])
	await expect(f.api.putServiceEnv({ serviceId: f.serviceId, key: 'FABRIKA_RELEASE', value: 'service-variable', signal: signal() })).rejects.toThrow()
	const release = listed.find((record) => record.key === 'FABRIKA_RELEASE')
	await expect(f.api.deleteServiceEnv({ envId: release?.id ?? '', signal: signal() })).rejects.toThrow('userDataDeleteForbidden')

	// A version still building leaves the active version's values in place, across a restart too.
	const second = await deploy('release-b', null)
	expect(await envRecords(f.state)).toEqual({ APP_LABEL: 'a', FABRIKA_RELEASE: 'release-a' })
	const restarted = await client({ stateFile: path, now: () => now })
	expect(await envRecords(restarted.state)).toEqual({ APP_LABEL: 'a', FABRIKA_RELEASE: 'release-a' })
	now = 300
	expect((await restarted.api.getAppVersion({ appVersionId: second.id, signal: signal() })).status).toBe('ACTIVE')
	expect(await envRecords(restarted.state)).toEqual({ FABRIKA_RELEASE: 'release-b' })
	expect((await restarted.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })).map(({ key }) => key)).toEqual(['FABRIKA_RELEASE'])
})

const tarEntry = (path: string, contents: string): Uint8Array => {
	const body = new TextEncoder().encode(contents)
	const header = new Uint8Array(512)
	const put = (offset: number, text: string) => header.set(new TextEncoder().encode(text), offset)
	put(0, path)
	put(100, '0000644\0')
	put(108, '0000000\0')
	put(116, '0000000\0')
	put(124, `${body.byteLength.toString(8).padStart(11, '0')}\0`)
	put(136, '00000000000\0')
	put(148, '        ')
	put(156, '0')
	put(257, 'ustar\0')
	put(263, '00')
	const checksum = header.reduce((sum, byte) => sum + byte, 0)
	put(148, `${checksum.toString(8).padStart(6, '0')}\0 `)
	const padded = new Uint8Array(Math.ceil(body.byteLength / 512) * 512)
	padded.set(body)
	return new Uint8Array([...header, ...padded])
}

test('records the uploaded descriptor digest and the build setup a version was built with', async () => {
	const f = await fixture()
	const archive = Bun.gzipSync(new Uint8Array([...tarEntry('app.ts', 'export {}\n'), ...tarEntry('zerops.yaml', descriptor), ...new Uint8Array(1024)]))
	const reservation = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	expect((await f.upload(reservation.uploadUrl, archive)).status).toBe(200)
	await f.api.buildAndDeployAppVersion({ appVersionId: reservation.id, zeropsYaml: descriptor, zeropsYamlSetup: 'api', signal: signal() })
	expect((await f.state()).appVersions.find((version) => version.id === reservation.id)).toMatchObject({
		uploadedDescriptorSha256: createHash('sha256').update(descriptor).digest('hex'),
		buildSetup: 'api',
	})
	const opaque = await f.api.createAppVersion({ serviceId: f.serviceId, signal: signal() })
	expect((await f.upload(opaque.uploadUrl)).status).toBe(200)
	expect((await f.state()).appVersions.find((version) => version.id === opaque.id)?.uploadedDescriptorSha256).toBeUndefined()
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

test('a managed service variable is a sensitive USER record; codeless reimport demotes HTTP version', async () => {
	const f = await fixture()
	await f.api.putServiceEnv({ serviceId: f.serviceId, key: 'FABRIKA_APP_ID', value: 'demo', signal: signal() })
	const records = await f.api.listServiceEnv({ serviceId: f.serviceId, signal: signal() })
	expect(records).toEqual([expect.objectContaining({ key: 'FABRIKA_APP_ID', content: 'demo', type: 'USER', sensitive: true })])
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
			{ id: 'e3', serviceStackId: 's', key: 'FABRIKA_RELEASE', content: 'release-1', type: 'ENV' },
		],
		appVersions: [
			{
				id: 'v1',
				serviceStackId: 's',
				projectId: 'p',
				status: 'ACTIVE',
				sequence: 1,
				name: 'run-1',
				hasHttpPorts: true,
				runEnvVariables: { FABRIKA_RELEASE: 'release-1' },
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

test('the state file refuses a non-string run variable and a raw upload capability', () => {
	const version = { id: 'v', projectId: 'p', serviceStackId: 's', status: 'BUILDING', sequence: 1 }
	expect(() => parseSnapshot({ ...emptySnapshot(), appVersions: [{ ...version, runEnvVariables: { FABRIKA_RELEASE: 1 } }] })).toThrow(
		/^invalid Zerops emulator state at appVersions\.0\.runEnvVariables\.FABRIKA_RELEASE: .*; run `bun run local:reset`$/,
	)
	const grant = { appVersionId: 'v', capabilitySha256: 'a'.repeat(64), deleted: false, capability: 'secret' }
	expect(() => parseSnapshot({ ...emptySnapshot(), uploadGrants: [grant] })).toThrow(
		/^invalid Zerops emulator state at uploadGrants\.0: .*; run `bun run local:reset`$/,
	)
})
