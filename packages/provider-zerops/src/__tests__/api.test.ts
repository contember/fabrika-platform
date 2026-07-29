import { describe, expect, test } from 'bun:test'
import { createZeropsApi, type FetchLike } from '../api'

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const signal = (): AbortSignal => new AbortController().signal

describe('Zerops API discovery', () => {
	test('lists every client project by following totalCount pages', async () => {
		const urls: string[] = []
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url)
			if (url.endsWith('offset=0')) {
				return jsonResponse({
					list: [
						{ id: 'project-1', name: 'apps-prod', mode: 'SERIOUS', status: 'ACTIVE' },
						{ id: 'project-2', name: 'apps-stage', mode: 'LIGHT', status: 'STOPPED' },
					],
					totalCount: 3,
				})
			}
			return jsonResponse({
				list: [{ id: 'project-3', name: 'billing-prod', mode: 'SERIOUS', status: 'CREATING' }],
				totalCount: 3,
			})
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.listProjects({ clientId: 'client-1', signal: signal() })).resolves.toEqual([
			{ id: 'project-1', name: 'apps-prod', mode: 'SERIOUS', status: 'ACTIVE' },
			{ id: 'project-2', name: 'apps-stage', mode: 'LIGHT', status: 'STOPPED' },
			{ id: 'project-3', name: 'billing-prod', mode: 'SERIOUS', status: 'CREATING' },
		])
		expect(urls).toEqual([
			'https://zerops.test/client/client-1/project?limit=100&offset=0',
			'https://zerops.test/client/client-1/project?limit=100&offset=2',
		])
	})

	test('keeps every exact-name project match and encodes the name', async () => {
		const urls: string[] = []
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url)
			return jsonResponse({
				projects: [
					{ id: 'project-1', name: 'apps prod', mode: 'SERIOUS' },
					{ id: 'project-2', name: 'apps prod', mode: 'LIGHT' },
				],
			})
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.findProjects({ clientId: 'client-1', name: 'apps prod', signal: signal() })).resolves.toEqual([
			{ id: 'project-1', name: 'apps prod', mode: 'SERIOUS', status: undefined },
			{ id: 'project-2', name: 'apps prod', mode: 'LIGHT', status: undefined },
		])
		expect(urls).toEqual(['https://zerops.test/client/client-1/projects-by-name/apps%20prod'])
	})

	test('reads project details using the documented mode field', async () => {
		const fetchImpl: FetchLike = async () =>
			jsonResponse({
				id: 'project-1',
				name: 'apps-prod',
				mode: 'SERIOUS',
				status: 'ACTIVE',
				corePackage: 'LIGHT',
				description: 'Managed by Fabrika namespace apps-prod (prod).',
				tagList: ['fabrika', 'namespace'],
			})
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.getProject({ projectId: 'project-1', signal: signal() })).resolves.toEqual({
			id: 'project-1',
			name: 'apps-prod',
			mode: 'SERIOUS',
			status: 'ACTIVE',
			description: 'Managed by Fabrika namespace apps-prod (prod).',
			tagList: ['fabrika', 'namespace'],
		})
	})

	test('lists every service stack and preserves its base and status', async () => {
		const urls: string[] = []
		const fetchImpl: FetchLike = async (url) => {
			urls.push(url)
			if (url.endsWith('offset=0')) {
				return jsonResponse({
					list: [
						{
							id: 'service-1',
							name: 'proxy',
							projectId: 'project-1',
							base: 'alpine/caddy@2.10',
							status: 'ACTIVE',
							activeAppVersion: { id: 'version-1' },
							subdomainAccess: false,
							autoscalingProfileId: 'oltp-production',
						},
					],
					totalCount: 2,
				})
			}
			return jsonResponse({
				list: [{ id: 'service-2', name: 'postgres', projectId: 'project-1', base: 'postgresql:ha@18', status: 'CREATING' }],
				totalCount: 2,
			})
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.listProjectServices({ projectId: 'project-1', signal: signal() })).resolves.toEqual([
			{
				id: 'service-1',
				name: 'proxy',
				projectId: 'project-1',
				base: 'alpine/caddy@2.10',
				status: 'ACTIVE',
				activeAppVersionId: 'version-1',
				subdomainAccess: false,
				autoscalingProfileId: 'oltp-production',
			},
			{
				id: 'service-2',
				name: 'postgres',
				projectId: 'project-1',
				base: 'postgresql:ha@18',
				status: 'CREATING',
				activeAppVersionId: undefined,
			},
		])
		expect(urls).toEqual([
			'https://zerops.test/project/project-1/service-stack?limit=100&offset=0',
			'https://zerops.test/project/project-1/service-stack?limit=100&offset=1',
		])
	})

	test('redacts a proxy IAM key from service-env write failures', async () => {
		const secret = 'proxy-key-that-must-not-leak'
		const fetchImpl: FetchLike = async (_url, init) =>
			init?.method === 'GET'
				? jsonResponse({ list: [], totalCount: 0 })
				: jsonResponse({ error: { message: `invalid value ${secret}` } }, 422)
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		let message = ''
		try {
			await api.putServiceEnv({ serviceId: 'proxy', key: 'FABRIKA_IAM_KEY', value: secret, signal: signal() })
		} catch (error) {
			message = error instanceof Error ? error.message : String(error)
		}
		expect(message).toContain('create service env failed (422)')
		expect(message).not.toContain(secret)
	})

	test('fails when pagination ends before the documented totalCount', async () => {
		let calls = 0
		const fetchImpl: FetchLike = async () => {
			calls++
			return calls === 1
				? jsonResponse({ list: [{ id: 'project-1', name: 'apps-prod' }], totalCount: 2 })
				: jsonResponse({ list: [], totalCount: 2 })
		}
		const api = createZeropsApi({ token: 'secret', baseUrl: 'https://zerops.test', fetchImpl })

		await expect(api.listProjects({ clientId: 'client-1', signal: signal() })).rejects.toThrow(
			'zerops: list projects ended before totalCount',
		)
	})
})
