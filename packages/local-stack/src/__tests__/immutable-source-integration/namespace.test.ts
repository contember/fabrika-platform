import {
	createZeropsApi,
	createZeropsArtifactSourceDescriptor,
	runZeropsProxyAttempt,
	ZeropsApiError,
	type ZeropsNamespaceTarget,
	zeropsNamespaceTargetCodec,
} from '@fabrika/provider-zerops'
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { HttpZeropsSourceClient } from '../../../../control/src/node/source-client'
import { LOCAL_SOURCE_EMULATOR_ORIGIN, LOCAL_SOURCE_PLATFORM_REPOSITORY } from '../../local-source-contract'
import { prepareLocalSourceFixtures } from '../../local-source-fixtures/fixture'
import { createLocalSourceRuntime } from '../../local-source-runtime/runtime'
import { createZeropsEmulator } from '../../zerops-emulator'
import { parseSnapshot } from '../../zerops-emulator/snapshot'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
	const directory = await mkdtemp(join(import.meta.dir, '.fixture-'))
	directories.push(directory)
	const manifest = await prepareLocalSourceFixtures(join(directory, 'source'))
	const stateFile = join(directory, 'emulator.json')
	let now = 100
	let handler = await createZeropsEmulator({ token: 'test', stateFile, activationDelayMs: 100, now: () => now })
	const api = createZeropsApi({
		token: 'test',
		baseUrl: `${LOCAL_SOURCE_EMULATOR_ORIGIN}/api/rest/public`,
		fetchImpl: (url, init) => handler(new Request(url, init)),
		sleep: async () => {},
	})
	const signal = AbortSignal.timeout(10_000)
	const imported = await api.importProject({
		clientId: 'client',
		yaml: 'project: {name: integration}\nservices: [{hostname: proxy, startWithoutCode: true}]',
		signal,
	})
	const service = imported.services[0]
	if (service === undefined) throw new Error('proxy service missing')
	const uploads: Uint8Array[] = []
	const rpcKey = 'namespace-source-integration-key-00000000'
	const runtime = await createLocalSourceRuntime({
		fixtureDirectory: join(directory, 'source'),
		env: { FABRIKA_SOURCE_RPC_KEY: rpcKey },
		uploadFetch: async (url, init) => {
			const request = new Request(url, init)
			uploads.push(new Uint8Array(await request.clone().arrayBuffer()))
			return handler(request)
		},
	})
	const source = new HttpZeropsSourceClient({
		origin: 'http://source:3000',
		rpcKey,
		fetch: (url, init) => runtime.service.fetch(new Request(url, init)),
	})
	let persisted: ZeropsNamespaceTarget = {
		projectId: imported.projectId,
		proxyServiceId: service.id,
		ready: true,
		proxySource: {
			repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
			commitSha: manifest.platform.commitSha,
			descriptor: await createZeropsArtifactSourceDescriptor(manifest.platform.descriptorContents),
		},
	}
	const checkpoint = async (target: ZeropsNamespaceTarget) => {
		await Bun.write(join(directory, 'namespace.json'), JSON.stringify(zeropsNamespaceTargetCodec.encode(target)))
		persisted = zeropsNamespaceTargetCodec.decode(JSON.parse(await Bun.file(join(directory, 'namespace.json')).text()))
	}
	const state = async () =>
		parseSnapshot(
			await (await handler(new Request(`${LOCAL_SOURCE_EMULATOR_ORIGIN}/__local/state`, { headers: { authorization: 'Bearer test' } }))).json(),
		)
	return {
		api,
		source,
		uploads,
		manifest,
		state,
		checkpoint,
		target: () => persisted,
		input: () => ({
			target: persisted,
			api,
			source,
			manifest: '{"apps":[]}',
			iamUrl: 'https://iam.example.test',
			iamKey: 'test-key',
			signal,
			checkpoint,
			refresh: false,
		}),
		restart: async () => {
			now = 200
			handler = await createZeropsEmulator({ token: 'test', stateFile, activationDelayMs: 100, now: () => now })
		},
	}
}

test('real authenticated namespace source attempt resumes its durable submitted version without reserving or building again', async () => {
	const f = await fixture()
	const submitted = await runZeropsProxyAttempt({ ...f.input(), wait: 'started' })
	const build = submitted.proxyBuild
	if (build === undefined) throw new Error('submitted checkpoint missing')
	expect(build.phase).toBe('build_triggered')
	expect(submitted.proxySource).toEqual(build.source)
	expect(build.source.commitSha).toBe(f.manifest.platform.commitSha)
	expect(build.source.descriptor.sha256).toBe(f.manifest.platform.descriptorSha256)
	const before = await f.state()
	const upload = f.uploads[0]
	if (upload === undefined) throw new Error('real source did not upload')
	expect(f.uploads).toHaveLength(1)
	expect(gunzipSync(upload).includes(Buffer.from(f.manifest.platform.descriptorContents))).toBe(true)
	expect(before.uploadGrants).toMatchObject([{
		appVersionId: build.appVersionId,
		deleted: false,
		receipt: {
			compressedBytes: upload.byteLength,
			compressedSha256: createHash('sha256').update(upload).digest('hex'),
		},
	}])
	expect(before.processes.filter(item => item.actionName === 'stack.build')).toMatchObject([{ id: build.processId, appVersionId: build.appVersionId }])
	await f.restart()
	const recovered = await runZeropsProxyAttempt({ ...f.input(), wait: 'active' })
	expect(recovered.proxyBuild).toBeUndefined()
	expect(recovered.proxyDeployment).toMatchObject({
		appVersionId: build.appVersionId,
		repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
		commitSha: f.manifest.platform.commitSha,
		descriptorSha256: f.manifest.platform.descriptorSha256,
	})
	const after = await f.state()
	expect(after.nextVersion).toBe(before.nextVersion)
	expect(after.processes.filter(item => item.actionName === 'stack.build')).toEqual(before.processes.filter(item => item.actionName === 'stack.build'))
	expect(after.uploadGrants).toEqual(before.uploadGrants)
	expect(after.services.find(item => item.id === recovered.proxyServiceId)?.activeAppVersionId).toBe(build.appVersionId)
	expect(f.uploads).toHaveLength(1)
})

test('lease loss after reservation leaves a durable inert version that recovery deletes before its replacement', async () => {
	const f = await fixture()
	const previousActive = (await f.state()).services.find(item => item.id === f.target().proxyServiceId)?.activeAppVersionId
	expect(previousActive).toBeDefined()
	const ownership = new AbortController()
	await expect(runZeropsProxyAttempt({
		...f.input(),
		ownershipSignal: ownership.signal,
		wait: 'started',
		checkpoint: async target => {
			await f.checkpoint(target)
			if (target.proxyBuild?.phase === 'version_created') ownership.abort()
		},
	})).rejects.toMatchObject({ kind: 'lease_lost' })
	const inert = f.target().proxyBuild
	if (inert === undefined) throw new Error('inert checkpoint missing')
	expect(inert.phase).toBe('version_created')
	expect(f.uploads).toHaveLength(0)
	expect((await f.state()).processes.filter(item => item.actionName === 'stack.build')).toHaveLength(0)
	await f.restart()
	const resumed = await runZeropsProxyAttempt({ ...f.input(), wait: 'started' })
	expect(resumed.proxyBuild?.appVersionId).not.toBe(inert.appVersionId)
	try {
		await f.api.getAppVersion({ appVersionId: inert.appVersionId, signal: AbortSignal.timeout(1000) })
		throw new Error('inert reservation survived recovery')
	} catch (error) {
		expect(error).toBeInstanceOf(ZeropsApiError)
		if (!(error instanceof ZeropsApiError)) throw error
		expect(error.status).toBe(400)
		expect(error.code).toBe('appVersionNotFound')
	}
	expect((await f.state()).uploadGrants.find(item => item.appVersionId === inert.appVersionId)).toMatchObject({ deleted: true })
	expect((await f.state()).services.find(item => item.id === f.target().proxyServiceId)?.activeAppVersionId).toBe(previousActive)
	await expect(f.api.buildAndDeployAppVersion({
		appVersionId: inert.appVersionId,
		zeropsYaml: f.manifest.platform.descriptorContents,
		zeropsYamlSetup: 'proxy',
		signal: AbortSignal.timeout(1000),
	})).rejects.toMatchObject({ status: 400, code: 'appVersionNotFound' })
	expect((await f.state()).processes.filter(item => item.actionName === 'stack.build')).toHaveLength(1)
})

test('an unknown pinned commit fails real source admission before namespace reservation or build', async () => {
	const f = await fixture()
	const target = f.target()
	if (target.proxySource === undefined) throw new Error('fixture pin missing')
	const before = await f.state()
	await expect(runZeropsProxyAttempt({
		...f.input(),
		target: { ...target, proxySource: { ...target.proxySource, commitSha: 'f'.repeat(40) } },
		wait: 'started',
	})).rejects.toThrow()
	expect(f.uploads).toHaveLength(0)
	const after = await f.state()
	expect(after.nextVersion).toBe(before.nextVersion)
	expect(after.uploadGrants).toEqual([])
	expect(after.processes).toEqual(before.processes)
	expect(f.target()).toEqual(target)
})
