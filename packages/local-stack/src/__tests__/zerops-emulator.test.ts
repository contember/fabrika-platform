import { createZeropsApi, type FetchLike } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { createZeropsEmulator } from '../zerops-emulator'

const token = 'local-test-token'
const signal = AbortSignal.timeout(5_000)

const client = async (options: { activationDelayMs?: number; now?: () => number } = {}) => {
	const handler = await createZeropsEmulator({ token, ...options })
	const fetchImpl: FetchLike = async (input, init) => handler(new Request(input, init))
	return createZeropsApi({
		token,
		baseUrl: 'http://zerops.local/api/rest/public',
		fetchImpl,
	})
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
				'  - hostname: notesapi',
				'    type: alpine/bun@1.3',
				'    envIsolation: service',
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
		expect(process?.status).toBe('FINISHED')
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

	test('rejects the wrong bearer before exposing state', async () => {
		const handler = await createZeropsEmulator({ token })
		const response = await handler(new Request('http://zerops.local/api/rest/public/__local/state'))
		expect(response.status).toBe(401)
	})
})
