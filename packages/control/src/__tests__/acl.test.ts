import type { AuthContext } from '@fabrika/auth'
import { uuidv7 } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import type { ControlJobMessage } from '../run-lifecycle'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { allowAllAuth, authWithActions, authWithPermissions } from './helpers/iam'
import { fakeControlProvider, providerEnvironment } from './helpers/provider'
import { rpcRequest, rpcResult } from './helpers/rpc'

// ACL enforcement at the API boundary, exercised with resolved dev contexts. Each context carries a
// permissions array that `can()` checks against the requested action and scope.

/** In-memory deps for the router: real Db over sqlite, a recording queue, an empty R2 reader. */
function makeDeps(auth: AuthContext): { deps: ControlRpcDeps; queue: ControlJobMessage[]; sqlite: ReturnType<typeof createHarness>['sqlite'] } {
	const { db, sqlite } = createHarness()
	const queue: ControlJobMessage[] = []
	const deps: ControlRpcDeps = {
		repositories: db,
		auth,
		queue: {
			send(m) {
				queue.push(m)
				return Promise.resolve()
			},
		},
		logs: { get: () => Promise.resolve(null) },
		provider: fakeControlProvider,
		cancelRun: () => Promise.resolve(),
	}
	return { deps, queue, sqlite }
}

describe('ACL enforcement (resolved auth context)', () => {
	test('an allow-all caller can create an app (app.manage)', async () => {
		const { deps } = makeDeps(allowAllAuth())
		const response = await rpcResult(rpcRequest('apps.create', { id: 'app', repoUrl: 'github.com/acme/app' }), deps)
		expect(response.status).toBe(200)
	})

	test('a caller without app.manage cannot create an app', async () => {
		const { deps } = makeDeps(authWithActions(['deploy.read'], 'ro@fabrika.test'))
		const response = await rpcResult(rpcRequest('apps.create', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)
		expect(response.status).toBe(403)
	})

	test('a caller with only deploy.read can read runs but cannot trigger a deploy', async () => {
		// This caller holds deploy.read globally only.
		const { deps } = makeDeps(authWithActions(['deploy.read'], 'r@fabrika.test'))
		// Seed an app + env so the scoped guard can hide the resolved target.
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))

		const read = await rpcResult(rpcRequest('runs.list', {}), deps)
		expect(read.status).toBe(200)

		const trigger = await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'prod' }), deps)
		expect(trigger.status).toBe(404)
		const missing = await rpcResult(rpcRequest('deploy', { appId: 'missing', env: 'prod' }), deps)
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
		await appRead.deps.repositories.runs.createRun({ id: alphaRun, appId: 'alpha', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
		await appRead.deps.repositories.runs.createRun({ id: betaRun, appId: 'beta', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })

		expect((await rpcResult(rpcRequest('runs.get', { runId: alphaRun }), appRead.deps)).status).toBe(200)
		expect((await rpcResult(rpcRequest('runs.get', { runId: betaRun }), appRead.deps)).status).toBe(404)
		expect((await rpcResult(rpcRequest('runs.log', { runId: betaRun }), appRead.deps)).status).toBe(404)
		expect((await rpcResult(rpcRequest('runs.tail', { runId: betaRun }), appRead.deps)).status).toBe(404)
		expect((await rpcResult(rpcRequest('runs.list', { appId: 'alpha' }), appRead.deps)).status).toBe(200)
		expect((await rpcResult(rpcRequest('runs.list', { appId: 'beta' }), appRead.deps)).status).toBe(403)
		expect((await rpcResult(rpcRequest('runs.list', {}), appRead.deps)).status).toBe(403)
		expect((await rpcResult(rpcRequest('runs.list', { statuses: ['pending', 'running'] }), appRead.deps)).status).toBe(403)
		const scopedActive = await rpcResult(rpcRequest('runs.list', { appId: 'alpha', statuses: ['pending', 'running'] }), appRead.deps)
		expect(scopedActive.status).toBe(200)
		const scopedActiveBody = await scopedActive.text()
		expect(scopedActiveBody).toContain(alphaRun)
		expect(scopedActiveBody).not.toContain(betaRun)
		for (const id of [alphaRun, betaRun]) {
			appRead.sqlite.query(`UPDATE runs SET status = 'failed', finished_at = 1 WHERE id = ?`).run(id)
		}
		const latestFailures = await rpcResult(rpcRequest('runs.latestFailures'), appRead.deps)
		expect(latestFailures.status).toBe(200)
		const latestFailuresBody = await latestFailures.text()
		expect(latestFailuresBody).toContain(alphaRun)
		expect(latestFailuresBody).not.toContain(betaRun)

		const envTrigger = makeDeps(authWithPermissions([{ action: 'deploy.trigger', scope: { type: 'environment', value: 'prod' } }]))
		await envTrigger.deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await envTrigger.deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		await envTrigger.deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'stage'))
		expect((await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'prod' }), envTrigger.deps)).status).toBe(200)
		expect((await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'stage' }), envTrigger.deps)).status).toBe(404)
		expect((await rpcResult(rpcRequest('runs.cancel', { runId: alphaRun }), appRead.deps)).status).toBe(404)
	})

	test('a caller with deploy.* can trigger a deploy (enqueues + creates the run)', async () => {
		const { deps, queue } = makeDeps(authWithActions(['deploy.*'], 'op@fabrika.test'))
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', defaultBranch: 'main' })
		await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))

		const response = await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'prod' }), deps)
		expect(response.status).toBe(200)
		const run: unknown = await response.json()
		const runId = objectString(run, 'id')
		expect(objectString(run, 'trigger')).toBe('manual')
		expect(objectString(run, 'ref')).toBe('refs/heads/main') // defaulted from the app's default branch
		expect(queue).toEqual([{ runId }])
	})

	test('only a person deploys to a protected environment by hand, and never a workspace branch', async () => {
		const deployer = authWithActions(['deploy.*'], 'op@fabrika.test')
		const service: AuthContext = { ...deployer, principal: { id: 'svc', type: 'service', label: 'builder' } }
		const agent: AuthContext = {
			...deployer,
			oauth: { app: 'vozka', clientId: 'https://claude.ai/oauth/client.json', scopes: ['authoring'], grantId: 'g', tokenId: 't' },
		}
		const person = 'environment `prod` is protected: only a person deploys it by hand, from the console; an agent, a builder key or a '
			+ "service key cannot. A push to the environment's trigger ref still deploys it"
		const workspace = "environment `prod` is protected: a workspace branch reaches it only after it is merged into the environment's trigger ref"
		for (const auth of [service, agent]) {
			const { deps, queue } = makeDeps(auth)
			await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', defaultBranch: 'main' })
			await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
			await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'stage'))
			const refused = await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'prod' }), deps)
			expect(refused.status).toBe(403)
			expect(await refused.text()).toContain(person)
			// An unprotected environment still takes a key or an agent.
			expect((await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'stage' }), deps)).status).toBe(200)
			expect(queue).toHaveLength(1)
		}

		const { deps, queue } = makeDeps(deployer)
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', defaultBranch: 'main' })
		await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		const branch = await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'prod', ref: 'refs/heads/fabrika/0190' }), deps)
		expect(branch.status).toBe(403)
		expect(await branch.text()).toContain(workspace)
		expect(queue).toEqual([])
		expect((await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'prod' }), deps)).status).toBe(200)
		expect(queue).toHaveLength(1)
	})

	test('a protected environment takes a full ref or a commit SHA, so a workspace branch has no short spelling', async () => {
		const { deps, queue } = makeDeps(authWithActions(['deploy.*'], 'op@fabrika.test'))
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', defaultBranch: 'main' })
		await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		for (const ref of ['fabrika/0190', 'heads/fabrika/0190', 'main', 'refs/heads/', 'a'.repeat(39), 'A'.repeat(40)]) {
			const refused = await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'prod', ref }), deps)
			expect(refused.status).toBe(400)
			expect(await refused.text()).toContain(
				`environment \`prod\` is protected: ref \`${ref}\` must be a full ref (refs/heads/<branch>, refs/tags/<tag>) or a 40-character commit SHA`,
			)
		}
		expect(queue).toEqual([])
		for (const ref of ['a'.repeat(40), 'refs/tags/v1.2.0', 'refs/heads/main']) {
			expect((await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'prod', ref }), deps)).status).toBe(200)
		}
		expect(queue).toHaveLength(3)
	})

	test('a caller without deploy.trigger learns nothing of a protected environment', async () => {
		const reader = authWithActions(['deploy.read'], 'r@fabrika.test')
		const { deps } = makeDeps({ ...reader, principal: { id: 'svc', type: 'service', label: 'reader' } })
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		const hidden = await rpcResult(rpcRequest('deploy', { appId: 'app', env: 'prod' }), deps)
		expect(hidden.status).toBe(404)
		expect(await hidden.text()).toBe(await (await rpcResult(rpcRequest('deploy', { appId: 'missing', env: 'prod' }), deps)).text())
	})

	test('unknown RPC procedure → 404', async () => {
		const { deps } = makeDeps(allowAllAuth())
		expect((await rpcResult(rpcRequest('nope'), deps)).status).toBe(404)
	})
})

function objectString(value: unknown, field: string): string {
	if (typeof value !== 'object' || value === null) throw new Error('expected an object')
	const fieldValue = Reflect.get(value, field)
	if (typeof fieldValue !== 'string') throw new Error(`${field} must be a string`)
	return fieldValue
}
