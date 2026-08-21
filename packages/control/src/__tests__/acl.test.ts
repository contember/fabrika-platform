import type { AuthContext } from '@fabrika/auth'
import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import { uuidv7 } from '../db'
import { FakeRepoSource } from '../repo-source'
import type { ControlJobMessage } from '../run-lifecycle'
import { createHarness } from './helpers/harness'
import { allowAllAuth, authWithActions, authWithPermissions } from './helpers/iam'
import { fakeControlProvider, providerEnvironment } from './helpers/provider'

// ACL enforcement at the API boundary, exercised with resolved dev contexts. Each context carries a
// permissions array that `can()` checks against the requested action and scope.

/** In-memory deps for the router: real Db over sqlite, a recording queue, an empty R2 reader. */
function makeDeps(auth: AuthContext): { deps: ApiDeps; queue: ControlJobMessage[]; sqlite: ReturnType<typeof createHarness>['sqlite'] } {
	const { db, sqlite } = createHarness()
	const queue: ControlJobMessage[] = []
	const deps: ApiDeps = {
		repositories: db,
		auth,
		queue: {
			send(m) {
				queue.push(m)
				return Promise.resolve()
			},
		},
		logs: { get: () => Promise.resolve(null) },
		repoSource: new FakeRepoSource(),
		provider: fakeControlProvider,
		cancelRun: () => Promise.resolve(),
	}
	return { deps, queue, sqlite }
}

function req(method: string, path: string, body?: unknown): Request {
	return new Request(`https://vozka.example${path}`, {
		method,
		...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
	})
}

describe('ACL enforcement (resolved auth context)', () => {
	test('an allow-all caller can create an app (app.manage)', async () => {
		const { deps } = makeDeps(allowAllAuth())
		const response = await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'github.com/acme/app' }), deps)
		expect(response.status).toBe(201)
	})

	test('a caller without app.manage cannot create an app', async () => {
		const { deps } = makeDeps(authWithActions(['deploy.read'], 'ro@vozka.test'))
		const response = await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)
		expect(response.status).toBe(403)
	})

	test('a caller with only deploy.read can read runs but cannot trigger a deploy', async () => {
		// This caller holds deploy.read globally only.
		const { deps } = makeDeps(authWithActions(['deploy.read'], 'r@vozka.test'))
		// Seed an app + env so the scoped guard can hide the resolved target.
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))

		const read = await handleApi(req('GET', '/api/runs'), deps)
		expect(read.status).toBe(200)

		const trigger = await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'prod' }), deps)
		expect(trigger.status).toBe(404)
		const missing = await handleApi(req('POST', '/api/deploy', { appId: 'missing', env: 'prod' }), deps)
		expect(missing.status).toBe(404)
		expect(await trigger.text()).toBe(await missing.text())
	})

	test('scopes run reads and deploy mutations to either the app or environment dimension', async () => {
		const appRead = makeDeps(authWithPermissions([{ action: 'deploy.read', scope: { type: 'app', value: 'alpha' } }]))
		for (const id of ['alpha', 'beta']) {
			await appRead.deps.repositories.registry.createApp({ id, repoUrl: `github.com/acme/${id}` })
			await appRead.deps.repositories.registry.upsertAppEnv(providerEnvironment(id, 'prod'))
		}
		const alphaRun = uuidv7()
		const betaRun = uuidv7()
		await appRead.deps.repositories.runs.createRun({ id: alphaRun, appId: 'alpha', env: 'prod', ref: 'main', trigger: 'manual' })
		await appRead.deps.repositories.runs.createRun({ id: betaRun, appId: 'beta', env: 'prod', ref: 'main', trigger: 'manual' })

		expect((await handleApi(req('GET', `/api/runs/${alphaRun}`), appRead.deps)).status).toBe(200)
		expect((await handleApi(req('GET', `/api/runs/${betaRun}`), appRead.deps)).status).toBe(404)
		expect((await handleApi(req('GET', `/api/runs/${betaRun}/log`), appRead.deps)).status).toBe(404)
		expect((await handleApi(req('GET', `/api/runs/${betaRun}/tail`), appRead.deps)).status).toBe(404)
		expect((await handleApi(req('GET', '/api/runs?app=alpha'), appRead.deps)).status).toBe(200)
		expect((await handleApi(req('GET', '/api/runs?app=beta'), appRead.deps)).status).toBe(403)
		expect((await handleApi(req('GET', '/api/runs'), appRead.deps)).status).toBe(403)

		const envTrigger = makeDeps(authWithPermissions([{ action: 'deploy.trigger', scope: { type: 'environment', value: 'prod' } }]))
		await envTrigger.deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await envTrigger.deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		await envTrigger.deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'stage'))
		expect((await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'prod' }), envTrigger.deps)).status).toBe(201)
		expect((await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'stage' }), envTrigger.deps)).status).toBe(404)
		expect((await handleApi(req('POST', `/api/runs/${alphaRun}/cancel`), appRead.deps)).status).toBe(404)
	})

	test('a caller with deploy.* can trigger a deploy (enqueues + creates the run)', async () => {
		const { deps, queue } = makeDeps(authWithActions(['deploy.*'], 'op@vozka.test'))
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', defaultBranch: 'main' })
		await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))

		const response = await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'prod' }), deps)
		expect(response.status).toBe(201)
		const run: unknown = await response.json()
		const runId = objectString(run, 'id')
		expect(objectString(run, 'trigger')).toBe('manual')
		expect(objectString(run, 'ref')).toBe('refs/heads/main') // defaulted from the app's default branch
		expect(queue).toEqual([{ runId }])
	})

	test('unknown route → 404, unknown method → 405', async () => {
		const { deps } = makeDeps(allowAllAuth())
		expect((await handleApi(req('GET', '/api/nope'), deps)).status).toBe(404)
		expect((await handleApi(req('DELETE', '/api/apps'), deps)).status).toBe(405)
	})
})

function objectString(value: unknown, field: string): string {
	if (typeof value !== 'object' || value === null) throw new Error('expected an object')
	const fieldValue = Reflect.get(value, field)
	if (typeof fieldValue !== 'string') throw new Error(`${field} must be a string`)
	return fieldValue
}
