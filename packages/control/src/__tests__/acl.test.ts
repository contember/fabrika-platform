import type { AuthContext } from '@fabrika/auth'
import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import { FakeRepoSource } from '../repo-source'
import type { DeployJobMessage } from '../run-lifecycle'
import { createHarness } from './helpers/harness'
import { allowAllAuth, authWithActions } from './helpers/iam'
import { fakeControlProvider, providerEnvironment } from './helpers/provider'

// ACL enforcement at the API boundary, exercised with resolved dev contexts. Each context carries a
// permissions array that `can()` checks against the requested action and scope.

/** In-memory deps for the router: real Db over sqlite, a recording queue, an empty R2 reader. */
function makeDeps(auth: AuthContext): { deps: ApiDeps; queue: DeployJobMessage[]; sqlite: ReturnType<typeof createHarness>['sqlite'] } {
	const { db, sqlite } = createHarness()
	const queue: DeployJobMessage[] = []
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

	test('a persona with only deploy.read can read runs but cannot trigger a deploy', async () => {
		// This persona holds deploy.read globally only.
		const { deps } = makeDeps(authWithActions(['deploy.read'], 'r@vozka.test'))
		// Seed an app + env so trigger gets past lookups (it should still 403 on the can-check first).
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))

		const read = await handleApi(req('GET', '/api/runs'), deps)
		expect(read.status).toBe(200)

		const trigger = await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'prod' }), deps)
		expect(trigger.status).toBe(403)
	})

	test('a persona with deploy.* can trigger a deploy (enqueues + creates the run)', async () => {
		const { deps, queue } = makeDeps(authWithActions(['deploy.*'], 'op@vozka.test'))
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', defaultBranch: 'main' })
		await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))

		const response = await handleApi(req('POST', '/api/deploy', { appId: 'app', env: 'prod' }), deps)
		expect(response.status).toBe(201)
		const run = (await response.json()) as { id: string; ref: string; trigger: string }
		expect(run.trigger).toBe('manual')
		expect(run.ref).toBe('refs/heads/main') // defaulted from the app's default branch
		expect(queue).toEqual([{ runId: run.id }])
	})

	test('unknown route → 404, unknown method → 405', async () => {
		const { deps } = makeDeps(allowAllAuth())
		expect((await handleApi(req('GET', '/api/nope'), deps)).status).toBe(404)
		expect((await handleApi(req('DELETE', '/api/apps'), deps)).status).toBe(405)
	})
})
