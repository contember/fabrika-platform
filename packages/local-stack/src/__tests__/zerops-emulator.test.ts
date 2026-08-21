import { createZeropsApi, type FetchLike, type Sleeper, waitForProcess } from '@fabrika/provider-zerops'
import { beforeAll, describe, expect, test } from 'bun:test'
import { type FactContext, factsFor, type FactTransport, runFact } from '../../../provider-zerops/src/__tests__/platform-facts'
import { createZeropsEmulator } from '../zerops-emulator'

const token = 'local-test-token'
const signal = AbortSignal.timeout(5_000)

const emulator = async (options: { activationDelayMs?: number; now?: () => number } = {}) => {
	const handler = await createZeropsEmulator({ token, ...options })
	const fetchImpl: FetchLike = async (input, init) => handler(new Request(input, init))
	return {
		handler,
		api: createZeropsApi({
			token,
			baseUrl: 'http://zerops.local/api/rest/public',
			fetchImpl,
			// Every user-data write now waits out its `stack.updateUserData` process; against the emulator
			// that is one extra read, and there is nothing to wait between them for.
			sleep: async () => {},
		}),
	}
}

const client = async (options: { activationDelayMs?: number; now?: () => number } = {}) => (await emulator(options)).api

/** Read one string off a raw emulator response without asserting anything about its shape. */
const stringField = (value: unknown, key: string): string | undefined => {
	const found = typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined
	return typeof found === 'string' ? found : undefined
}

describe('local Zerops emulator', () => {
	test('drives the real client through project, service, env, and pipeline lifecycle', async () => {
		const api = await client()
		const imported = await api.importProject({
			clientId: 'local-client',
			yaml: [
				'project:',
				'  name: apps-prod',
				'  corePackage: LIGHT',
				'  envIsolation: service',
				'services:',
				'  - hostname: proxy',
				'    type: alpine@3.21',
				'    envIsolation: service',
			].join('\n'),
			signal,
		})

		expect(imported.projectName).toBe('apps-prod')
		expect(imported.services.map((service) => service.name)).toEqual(['proxy'])
		const projectId = imported.projectId
		const proxyId = imported.services[0]?.id
		expect(proxyId).toBeDefined()
		if (proxyId === undefined) {
			throw new Error('proxy service id is missing')
		}

		const secondImport = await api.importServices({
			projectId,
			yaml: [
				'services:',
				'  - hostname: proxy',
				'    type: alpine@3.21',
				'    envIsolation: service',
				'    override: true',
				'  - hostname: notesapi',
				'    type: alpine/bun@1.3',
				'    envIsolation: service',
				'    override: true',
			].join('\n'),
			signal,
		})
		expect(secondImport.services[0]?.id).toBe(proxyId)

		const projects = await api.listProjects({ clientId: 'local-client', signal })
		expect(projects).toHaveLength(1)
		expect(await api.findProjects({ clientId: 'local-client', name: 'apps-prod', signal })).toHaveLength(1)
		expect(await api.listProjectServices({ projectId, signal })).toHaveLength(2)
		expect((await api.findService({ projectId, hostname: 'notesapi', signal }))?.name).toBe('notesapi')

		const notes = await api.findService({ projectId, hostname: 'notesapi', signal })
		if (notes === null) {
			throw new Error('notes service is missing')
		}
		await api.putServiceEnv({ serviceId: notes.id, key: 'NOTES_DATABASE_URL', value: 'secret-one', signal })
		await api.putServiceEnv({ serviceId: notes.id, key: 'NOTES_DATABASE_URL', value: 'secret-two', signal })
		const environment = await api.listServiceEnv({ serviceId: notes.id, signal })
		expect(environment).toHaveLength(1)
		expect(environment[0]?.content).toBe('secret-two')

		const process = await api.triggerPipeline({ serviceId: notes.id, buildFromGit: 'https://example.test/repo.git', signal })
		// A just-started process has not finished. It reports FINISHED from the second read on.
		expect(process?.status).toBe('PENDING')
		expect(process?.actionName).toBe('stack.deploy')
		const version = await api.latestAppVersion({ serviceId: notes.id, signal })
		expect(version?.status).toBe('ACTIVE')
		if (version === null) {
			throw new Error('app version is missing')
		}
		expect((await api.getAppVersion({ appVersionId: version.id, signal })).status).toBe('ACTIVE')
		await api.cancelBuild({ appVersionId: version.id, signal })
		expect((await api.getAppVersion({ appVersionId: version.id, signal })).status).toBe('CANCELLED')
		expect((await api.getLogAccess({ projectId, signal })).urlPlain).toBe('')
	})

	test('writes a secret to a service that was never deployed, the way ADR-0004 orders it', async () => {
		const api = await client()
		const imported = await api.importProject({
			clientId: 'local-client',
			yaml: ['project:', '  name: bringup', 'services:', '  - hostname: iam', '    type: alpine/bun@1.3'].join('\n'),
			signal,
		})
		const serviceId = imported.services[0]?.id ?? ''

		// The list endpoint answers 400 on every service, so nothing may read before it writes.
		await expect(api.listServiceEnv({ serviceId, signal })).resolves.toEqual([])
		await api.putServiceEnv({ serviceId, key: 'FABRIKA_IAM_KEY', value: 'first', signal })
		await api.putServiceEnv({ serviceId, key: 'FABRIKA_IAM_KEY', value: 'second', signal })

		const written = await api.listServiceEnv({ serviceId, signal })
		expect(written.map((entry) => entry.key)).toEqual(['FABRIKA_IAM_KEY'])
		expect(written[0]?.content).toBe('second')
		await api.deleteServiceEnv({ envId: written[0]?.id ?? '', signal })
		await expect(api.listServiceEnv({ serviceId, signal })).resolves.toEqual([])
	})

	test('keeps a pipeline building until its activation deadline', async () => {
		let now = 1_000
		const api = await client({ activationDelayMs: 500, now: () => now })
		const imported = await api.importProject({
			clientId: 'local-client',
			yaml: [
				'project:',
				'  name: delayed',
				'services:',
				'  - hostname: api',
				'    type: alpine/bun@1.3',
			].join('\n'),
			signal,
		})
		const serviceId = imported.services[0]?.id
		if (serviceId === undefined) {
			throw new Error('service id is missing')
		}

		await api.triggerPipeline({ serviceId, buildFromGit: 'https://example.test/repo.git', signal })
		const building = await api.latestAppVersion({ serviceId, signal })
		expect(building?.status).toBe('BUILDING')

		now = 1_500
		expect((await api.getAppVersion({ appVersionId: building?.id ?? '', signal })).status).toBe('ACTIVE')
		expect((await api.getService({ serviceId, signal })).activeAppVersionId).toBe(building?.id)
	})

	test('leaves an imported subdomain flag on the floor and publishes only after a deploy', async () => {
		const api = await client()
		const imported = await api.importProject({
			clientId: 'local-client',
			yaml: [
				'project:',
				'  name: subdomain',
				'services:',
				'  - hostname: proxy',
				'    type: alpine@3.21',
				'    enableSubdomainAccess: true',
			].join('\n'),
			signal,
		})
		const serviceId = imported.services[0]?.id
		if (serviceId === undefined) {
			throw new Error('proxy service id is missing')
		}

		// The platform accepts `enableSubdomainAccess` in an import and drops it, on a service it creates too.
		expect((await api.getService({ serviceId, signal })).subdomainAccess).toBe(false)
		await expect(api.enableSubdomainAccess({ serviceId, signal })).rejects.toThrow('serviceStackIsNotHttp')

		await api.triggerPipeline({ serviceId, buildFromGit: 'https://example.test/repo.git', signal })
		await api.enableSubdomainAccess({ serviceId, signal })
		expect((await api.getService({ serviceId, signal })).subdomainAccess).toBe(true)
	})

	test('hands an import a process per service it CREATED, and none for one it only re-applied', async () => {
		const api = await client()
		const imported = await api.importProject({
			clientId: 'local-client',
			yaml: ['project:', '  name: processes', 'services:', '  - hostname: iam', '    type: alpine/bun@1.3'].join('\n'),
			signal,
		})
		const created = imported.services[0]?.processes ?? []
		expect(created).toHaveLength(1)
		expect(created[0]?.id).not.toBe('')
		expect(created[0]?.actionName).toBe('stack.create')
		expect(created[0]?.serviceStackId).toBe(imported.services[0]?.id)

		const again = await api.importServices({
			projectId: imported.projectId,
			yaml: [
				'services:',
				'  - hostname: iam',
				'    type: alpine/bun@1.3',
				'    override: true',
				'  - hostname: control',
				'    type: alpine/bun@1.3',
				'    override: true',
			].join('\n'),
			signal,
		})
		// Re-applying an unchanged service is a complete no-op live — same id, no process.
		expect(again.services[0]?.processes).toEqual([])
		expect(again.services[1]?.processes).toHaveLength(1)
	})

	test('polls a process from PENDING to FINISHED, so a caller that waits really waits', async () => {
		const api = await client()
		const imported = await api.importProject({
			clientId: 'local-client',
			yaml: ['project:', '  name: waiting', 'services:', '  - hostname: iam', '    type: alpine/bun@1.3'].join('\n'),
			signal,
		})
		const started = imported.services[0]?.processes[0]
		if (started === undefined) {
			throw new Error('the import returned no process to wait on')
		}
		expect(started.status).toBe('PENDING')

		const slept: number[] = []
		const sleep: Sleeper = async (ms) => {
			slept.push(ms)
		}
		const finished = await waitForProcess({ api, processId: started.id, sleep, signal, intervalMs: 3 })

		expect(finished.id).toBe(started.id)
		expect(finished.status).toBe('FINISHED')
		// One PENDING read then FINISHED: the loop turned once. A double that answered FINISHED immediately
		// would pass this line while proving that a caller which never polls also works — it does not.
		expect(slept).toEqual([3])
	})

	test('names the app version on a pipeline process and 404s an id it never issued', async () => {
		const api = await client()
		const imported = await api.importProject({
			clientId: 'local-client',
			yaml: ['project:', '  name: pipeline', 'services:', '  - hostname: api', '    type: alpine/bun@1.3'].join('\n'),
			signal,
		})
		const serviceId = imported.services[0]?.id ?? ''
		const triggered = await api.triggerPipeline({ serviceId, buildFromGit: 'https://example.test/repo.git', signal })
		if (triggered === null) {
			throw new Error('the pipeline returned no process')
		}

		const read = await api.getProcess({ processId: triggered.id, signal })
		expect(read.appVersionId).toBe(triggered.appVersionId)
		expect(read.serviceStackId).toBe(serviceId)
		await expect(api.getProcess({ processId: 'process-999999', signal })).rejects.toThrow('(404)')
	})

	test('mints an integration token that is plainly not a credential', async () => {
		const { api, handler } = await emulator({ now: () => 1_000 })
		const minted = await api.createIntegrationToken({
			clientId: 'local-client',
			name: 'fabrika-control',
			projects: [{ projectId: 'project-000001', roleCode: 'ADMIN' }],
			signal,
		})

		expect(minted.id).not.toBe('')
		expect(minted.name).toBe('fabrika-control')
		// The client always sends the client-wide role, even at its default; the double echoes it back.
		expect(minted.roleCode).toBe('NO_ACCESS')
		expect(minted.projects).toEqual([{ projectId: 'project-000001', roleCode: 'ADMIN' }])
		expect(minted.token).toBe(`not-a-real-zerops-${minted.id}`)

		// The value is a LABEL: the double accepts exactly one bearer, the configured one. A flow that mints
		// and then authenticates with the result gets 401 here and would not on the platform.
		const refused = await handler(
			new Request('http://zerops.local/api/rest/public/__local/state', { headers: { authorization: `Bearer ${minted.token}` } }),
		)
		expect(refused.status).toBe(401)
	})

	test('stamps a minted token with the timestamps the schema requires', async () => {
		const { handler } = await emulator({ now: () => 1_000 })
		const response = await handler(
			new Request('http://zerops.local/api/rest/public/client/local-client/integration-token', {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'stamped', roleCode: 'NO_ACCESS', projects: [{ projectId: 'project-000001', roleCode: 'ADMIN' }] }),
			}),
		)
		const body: unknown = await response.json()

		expect(response.status).toBe(201)
		expect(stringField(body, 'created')).toBe(new Date(1_000).toISOString())
		expect(stringField(body, 'lastUpdate')).toBe(new Date(1_000).toISOString())
	})

	test('refuses an integration token request that names an unknown role', async () => {
		const { handler } = await emulator()
		const response = await handler(
			new Request('http://zerops.local/api/rest/public/client/local-client/integration-token', {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'wrong', projects: [{ projectId: 'project-000001', roleCode: 'SUPERUSER' }] }),
			}),
		)
		expect(response.status).toBe(400)
	})

	test('rejects the wrong bearer before exposing state', async () => {
		const handler = await createZeropsEmulator({ token })
		const response = await handler(new Request('http://zerops.local/api/rest/public/__local/state'))
		expect(response.status).toBe(401)
	})
})

/**
 * The SAME table `@fabrika/provider-zerops`'s opt-in live suite runs against a real account
 * (`platform-facts.live.test.ts`). A fact is a row there, and a row the double models is asserted here in
 * the same change — which is what stops the emulator drifting from the platform unnoticed. A deliberately
 * wrong row fails both sides, and that is the point.
 *
 * The rows run in table order and some depend on the row before, so `test` per row, no `test.each` reorder,
 * and one shared context the capturing rows fill in.
 */
describe('the platform-facts table, against the double', () => {
	const context: FactContext = new Map()
	let transport: FactTransport

	beforeAll(async () => {
		const baseUrl = 'http://zerops.local/api/rest/public'
		const handler = await createZeropsEmulator({ token })
		transport = {
			baseUrl,
			token,
			fetch: (url, init) => handler(new Request(url, init)),
			// Nothing here is really asynchronous; the poll loop still has to turn.
			sleep: async () => {},
			signal: AbortSignal.timeout(30_000),
		}
		// The account gives the live suite a project; here one is imported, with a service the table never
		// names so no row collides with it.
		const created = await handler(
			new Request(`${baseUrl}/client/local-client/project/import`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					yaml: ['project:', '  name: platformfacts', 'services:', '  - hostname: bootstrap', '    type: alpine@3.21'].join('\n'),
				}),
			}),
		)
		const projectId = stringField(await created.json(), 'projectId')
		if (projectId === undefined) {
			throw new Error('the emulator did not create a project for the fact table')
		}
		context.set('clientId', 'local-client')
		context.set('projectId', projectId)
		context.set('hostname', 'factsvc')
		context.set('deleteHostname', 'factdel')
		context.set('absentHostname', 'factabsent')
		context.set('setupProbeHostname', 'factsetup')
		context.set('absentAppVersionId', 'version-999999')
	})

	for (const fact of factsFor('emulator')) {
		test(fact.id, async () => {
			await runFact({ transport, fact, context })
		})
	}
})
