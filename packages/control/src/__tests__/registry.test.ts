import { OPERATIONS_MANAGED_ENVIRONMENT_KEYS } from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE } from '@fabrika/operations-contract/releases'
import type { ControlProvider, JsonValue, ProviderEnvelope, ProviderRegistrationInput } from '@fabrika/provider-contract'
import { logsKey } from '@fabrika/runner-cloudflare'
import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import { uuidv7 } from '../db'
import { FakeRepoSource } from '../repo-source'
import type { DeployJobMessage } from '../run-lifecycle'
import { createHarness } from './helpers/harness'
import { allowAllIam } from './helpers/iam'

// Registry + onboarding row creation, and run-history reads, driven through the real `handleApi`
// router against the real schema (in-memory sqlite). An allow-all dev authenticator lets us focus on
// the data path here; ACL is covered separately in acl.test.ts.

function makeDeps(
	opts: { installationId?: number | null; provider?: ControlProvider; catalogChanged?: () => void } = {},
): { deps: ApiDeps; queue: DeployJobMessage[]; logStore: Map<string, string> } {
	const { db } = createHarness()
	const queue: DeployJobMessage[] = []
	const logStore = new Map<string, string>()
	const deps: ApiDeps = {
		repositories: db,
		iam: allowAllIam(),
		queue: {
			send(m) {
				queue.push(m)
				return Promise.resolve()
			},
		},
		// An in-memory stand-in for the `BlobStore` port's read side (the R2 bucket vozka-runner streams
		// logs into). `body` is part of the port even though the log handlers only ever read `text()`.
		logs: {
			get: (key) => {
				const v = logStore.get(key)
				return Promise.resolve(v === undefined ? null : { body: new Blob([v]).stream(), text: () => Promise.resolve(v) })
			},
		},
		repoSource: new FakeRepoSource({ fakeInstallationId: opts.installationId ?? null }),
		provider: opts.provider ?? fakeProvider,
		// Stand in for the runner: mark the run failed (the real seam destroys the container + frees the lock).
		cancelRun: (run) => db.runs.markRunFinished(run.id, 'failed', null).then(() => {}),
		...(opts.catalogChanged === undefined ? {} : { catalogChanged: opts.catalogChanged }),
	}
	return { deps, queue, logStore }
}

const payloadObject = (envelope: ProviderEnvelope): { readonly [key: string]: JsonValue } => {
	const payload = envelope.payload
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('fake provider payload must be an object')
	}
	return payload
}

const payloadString = (envelope: ProviderEnvelope, name: string): string => {
	const value = payloadObject(envelope)[name]
	if (typeof value !== 'string') {
		throw new Error(`fake provider ${name} must be a string`)
	}
	return value
}

const fakeProvider: ControlProvider = {
	id: 'harbor',
	normalizeRegistration: (input: ProviderRegistrationInput) => {
		if (input.environment.target.provider !== 'harbor' || input.environment.artifact.provider !== 'harbor') {
			throw new Error('fake provider rejects foreign envelopes')
		}
		return {
			app: input.app,
			environment: {
				...input.environment,
				target: {
					provider: 'harbor',
					version: 1,
					payload: { region: payloadString(input.environment.target, 'region').trim().toLowerCase() },
				},
				artifact: {
					provider: 'harbor',
					version: 1,
					payload: { image: payloadString(input.environment.artifact, 'image').trim() },
				},
			},
		}
	},
	deploy: () => Promise.resolve({ state: 'succeeded' }),
}

const registrationEnvelopes = (): { target: ProviderEnvelope; artifact: ProviderEnvelope } => ({
	target: { provider: 'harbor', version: 1, payload: { region: 'eu' } },
	artifact: { provider: 'harbor', version: 1, payload: { image: 'registry.example/app:v1' } },
})

const storedEnvironment = (
	appId: string,
	env: string,
	options: { domain?: string | null; triggerRef?: string | null } = {},
) => {
	const envelopes = registrationEnvelopes()
	return {
		appId,
		env,
		...options,
		namespaceId: null,
		provider: 'harbor',
		providerTargetJson: JSON.stringify(envelopes.target),
		providerArtifactJson: JSON.stringify(envelopes.artifact),
	}
}

function req(method: string, path: string, body?: unknown): Request {
	const withRegistration = (
			(method === 'POST' && path === '/api/register-app')
			|| (method === 'PUT' && /^\/api\/apps\/[^/]+\/envs\/[^/]+$/.test(path))
		)
			&& typeof body === 'object'
			&& body !== null
			&& !Array.isArray(body)
		? { ...body, ...registrationEnvelopes() }
		: body
	return new Request(`https://vozka.example${path}`, {
		method,
		...(withRegistration !== undefined
			? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(withRegistration) }
			: {}),
	})
}

describe('onboarding + registry CRUD', () => {
	test('schedules every catalog-affecting mutation without letting a scheduling failure change the response', async () => {
		let scheduled = 0
		const { deps } = makeDeps({
			catalogChanged: () => {
				scheduled++
				throw new Error('operations unavailable')
			},
		})

		expect((await handleApi(req('POST', '/api/apps', { id: 'app-a', repoUrl: 'https://github.com/acme/app-a' }), deps)).status).toBe(201)
		expect((await handleApi(req('PATCH', '/api/apps/app-a', { defaultBranch: 'next' }), deps)).status).toBe(200)
		expect((await handleApi(req('PUT', '/api/apps/app-a/envs/prod', {}), deps)).status).toBe(200)
		expect((await handleApi(req('DELETE', '/api/apps/app-a/envs/prod'), deps)).status).toBe(200)
		expect((await handleApi(req('DELETE', '/api/apps/app-a'), deps)).status).toBe(200)
		expect(
			(await handleApi(
				req('POST', '/api/register-app', {
					id: 'app-b',
					repoUrl: 'https://github.com/acme/app-b',
					env: 'stage',
				}),
				deps,
			)).status,
		).toBe(201)
		expect(scheduled).toBe(6)
	})

	test('normalizes and round-trips a third provider without a registry branch', async () => {
		const { deps } = makeDeps()
		await handleApi(req('POST', '/api/apps', { id: 'harbor-app', repoUrl: 'https://github.com/acme/harbor-app' }), deps)
		const response = await handleApi(
			new Request('https://vozka.example/api/apps/harbor-app/envs/prod', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					domain: 'app.example.com',
					target: { provider: 'harbor', version: 1, payload: { region: ' EU-WEST ' } },
					artifact: { provider: 'harbor', version: 1, payload: { image: ' registry.example/app:v4 ' } },
				}),
			}),
			deps,
		)
		expect(response.status).toBe(200)
		const row = await deps.repositories.registry.getAppEnv('harbor-app', 'prod')
		expect(row?.provider).toBe('harbor')
		expect(row?.provider_target_json).toBe(
			JSON.stringify({ provider: 'harbor', version: 1, payload: { region: 'eu-west' } }),
		)
		expect(row?.provider_artifact_json).toBe(
			JSON.stringify({ provider: 'harbor', version: 1, payload: { image: 'registry.example/app:v4' } }),
		)

		const foreign = await handleApi(
			new Request('https://vozka.example/api/apps/harbor-app/envs/stage', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					target: { provider: 'other', version: 1, payload: { region: 'eu' } },
					artifact: { provider: 'harbor', version: 1, payload: { image: 'image' } },
				}),
			}),
			deps,
		)
		expect(foreign.status).toBe(400)
		expect(await deps.repositories.registry.getAppEnv('harbor-app', 'stage')).toBeNull()
	})

	test('registerApp creates the app + its first app_env in one call', async () => {
		const { deps } = makeDeps()

		const response = await handleApi(
			req('POST', '/api/register-app', {
				id: 'acme',
				repoUrl: 'https://github.com/acme/App.git',
				env: 'prod',
				domain: 'acme.example.com',
				triggerRef: 'refs/heads/deploy/prod',
			}),
			deps,
		)
		expect(response.status).toBe(201)

		// App row exists with the NORMALIZED repo URL.
		const app = await deps.repositories.registry.getApp('acme')
		expect(app?.repo_url).toBe('github.com/acme/App')
		// And its prod env row, with the domain + trigger ref.
		const env = await deps.repositories.registry.getAppEnv('acme', 'prod')
		expect(env?.domain).toBe('acme.example.com')
		expect(env?.trigger_ref).toBe('refs/heads/deploy/prod')
	})

	test('registerApp auto-detects the installation id when resolveInstallationId is set', async () => {
		const { deps } = makeDeps({ installationId: 424242 })
		const response = await handleApi(
			req('POST', '/api/register-app', { id: 'auto', repoUrl: 'https://github.com/acme/private', env: 'prod', resolveInstallationId: true }),
			deps,
		)
		expect(response.status).toBe(201)
		expect((await deps.repositories.registry.getApp('auto'))?.github_installation_id).toBe(424242)
	})

	test('an explicit githubInstallationId overrides auto-detect', async () => {
		const { deps } = makeDeps({ installationId: 424242 })
		await handleApi(
			req('POST', '/api/register-app', {
				id: 'manual',
				repoUrl: 'https://github.com/acme/private',
				env: 'prod',
				resolveInstallationId: true,
				githubInstallationId: 999,
			}),
			deps,
		)
		expect((await deps.repositories.registry.getApp('manual'))?.github_installation_id).toBe(999)
	})

	test('updateApp can back-fill the installation id via Detect on an existing app', async () => {
		const { deps } = makeDeps({ installationId: 555 })
		await handleApi(req('POST', '/api/apps', { id: 'existing', repoUrl: 'https://github.com/acme/private' }), deps)
		expect((await deps.repositories.registry.getApp('existing'))?.github_installation_id).toBe(null)

		const patched = await handleApi(req('PATCH', '/api/apps/existing', { resolveInstallationId: true }), deps)
		expect(patched.status).toBe(200)
		expect((await deps.repositories.registry.getApp('existing'))?.github_installation_id).toBe(555)
	})

	test('registerApp rejects a missing field (400) and a duplicate id (409)', async () => {
		const { deps } = makeDeps()
		const missing = await handleApi(req('POST', '/api/register-app', { id: 'x', repoUrl: 'r' }), deps)
		expect(missing.status).toBe(400) // env required

		await handleApi(req('POST', '/api/register-app', { id: 'dup', repoUrl: 'r', env: 'prod' }), deps)
		const dup = await handleApi(req('POST', '/api/register-app', { id: 'dup', repoUrl: 'r', env: 'stage' }), deps)
		expect(dup.status).toBe(409)
	})

	test('apps / app_envs / secrets CRUD round-trips', async () => {
		const { deps } = makeDeps()
		await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)

		// app_env upsert
		const putEnv = await handleApi(req('PUT', '/api/apps/app/envs/prod', { triggerRef: 'refs/heads/deploy/prod' }), deps)
		expect(putEnv.status).toBe(200)

		// secret upsert (a vault REFERENCE, not a value)
		const putSecret = await handleApi(req('PUT', '/api/apps/app/secrets', { name: 'API_KEY', valueRef: 'env:APP_API_KEY' }), deps)
		expect(putSecret.status).toBe(200)
		const secret = (await putSecret.json()) as { valueRef: string }
		expect(secret.valueRef).toBe('env:APP_API_KEY')

		// list secrets
		const listSecrets = await handleApi(req('GET', '/api/apps/app/secrets'), deps)
		const secrets = (await listSecrets.json()) as { items: unknown[] }
		expect(secrets.items).toHaveLength(1)

		// delete secret (all-env layer)
		const delSecret = await handleApi(req('DELETE', '/api/apps/app/secrets/API_KEY'), deps)
		expect(delSecret.status).toBe(200)
		expect(await deps.repositories.registry.listAppSecrets('app')).toHaveLength(0)

		// delete app cascades its env
		const delApp = await handleApi(req('DELETE', '/api/apps/app'), deps)
		expect(delApp.status).toBe(200)
		expect(await deps.repositories.registry.getAppEnv('app', 'prod')).toBeNull()
	})

	test('app_vars CRUD round-trips (plaintext value, readable — unlike secrets)', async () => {
		const { deps } = makeDeps()
		await handleApi(req('POST', '/api/apps', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)

		// var upsert (plaintext config value, e.g. propustka's ACCESS_APPS)
		const putVar = await handleApi(req('PUT', '/api/apps/app/vars', { name: 'PROPUSTKA_TEAM', value: 'https://contember.cloudflareaccess.com' }), deps)
		expect(putVar.status).toBe(200)
		// UNLIKE secrets, the VALUE is returned (vars are non-secret config).
		const v = (await putVar.json()) as { name: string; value: string }
		expect(v.value).toBe('https://contember.cloudflareaccess.com')

		// missing value → 400
		const bad = await handleApi(req('PUT', '/api/apps/app/vars', { name: 'X' }), deps)
		expect(bad.status).toBe(400)
		for (const name of [...OPERATIONS_MANAGED_ENVIRONMENT_KEYS, FABRIKA_RELEASE]) {
			const reserved = await handleApi(req('PUT', '/api/apps/app/vars', { name, value: 'user-owned' }), deps)
			expect(reserved.status).toBe(400)
		}

		// list vars
		const listVars = await handleApi(req('GET', '/api/apps/app/vars'), deps)
		const vars = (await listVars.json()) as { items: unknown[] }
		expect(vars.items).toHaveLength(1)

		// delete var (all-env layer)
		const delVar = await handleApi(req('DELETE', '/api/apps/app/vars/PROPUSTKA_TEAM'), deps)
		expect(delVar.status).toBe(200)
		expect(await deps.repositories.registry.listAppVars('app')).toHaveLength(0)
	})
})

describe('run history API', () => {
	test('lists runs newest-first and filters by app/env', async () => {
		const { deps } = makeDeps()
		await deps.repositories.registry.createApp({ id: 'a', repoUrl: 'r1' })
		await deps.repositories.registry.createApp({ id: 'b', repoUrl: 'r2' })
		await deps.repositories.registry.upsertAppEnv(storedEnvironment('a', 'prod'))
		await deps.repositories.registry.upsertAppEnv(storedEnvironment('b', 'prod'))
		const r1 = uuidv7()
		await deps.repositories.runs.createRun({ id: r1, appId: 'a', env: 'prod', ref: 'main', trigger: 'manual' })
		const r2 = uuidv7()
		await deps.repositories.runs.createRun({ id: r2, appId: 'b', env: 'prod', ref: 'main', trigger: 'webhook' })

		const all = await handleApi(req('GET', '/api/runs'), deps)
		const allBody = (await all.json()) as { items: { id: string }[] }
		expect(allBody.items).toHaveLength(2)
		// Returned in descending id order. UUIDv7 carries the RFC 9562 §6.2 monotonic counter, so r2 > r1
		// even though the two were minted inside one millisecond — the exact order is assertable.
		expect(allBody.items.map((i) => i.id)).toEqual([r2, r1])

		const filtered = await handleApi(req('GET', '/api/runs?app=a'), deps)
		const filteredBody = (await filtered.json()) as { items: { id: string }[] }
		expect(filteredBody.items).toHaveLength(1)
		expect(filteredBody.items[0]?.id).toBe(r1)
	})

	test('getRunLog reads + parses the NDJSON log from R2', async () => {
		const { deps, logStore } = makeDeps()
		await deps.repositories.registry.createApp({ id: 'a', repoUrl: 'r' })
		await deps.repositories.registry.upsertAppEnv(storedEnvironment('a', 'prod'))
		const runId = uuidv7()
		await deps.repositories.runs.createRun({ id: runId, appId: 'a', env: 'prod', ref: 'main', trigger: 'manual' })
		await deps.repositories.runs.markRunStarted(runId, logsKey(runId))
		// Stage two log lines in the fake R2 under the run's log key.
		logStore.set(
			logsKey(runId),
			[JSON.stringify({ ts: 1, stream: 'meta', text: 'Cloning' }), JSON.stringify({ ts: 2, stream: 'stdout', text: 'done' })].join('\n'),
		)

		const response = await handleApi(req('GET', `/api/runs/${runId}/log`), deps)
		expect(response.status).toBe(200)
		const body = (await response.json()) as { lines: { text: string }[] }
		expect(body.lines).toHaveLength(2)
		expect(body.lines[1]?.text).toBe('done')

		// tail with a cursor returns only the new lines + a done flag once terminal.
		const tail = await handleApi(req('GET', `/api/runs/${runId}/tail?after=1`), deps)
		const tailBody = (await tail.json()) as { lines: unknown[]; cursor: number; done: boolean }
		expect(tailBody.lines).toHaveLength(1)
		expect(tailBody.cursor).toBe(2)
	})

	test('getRun 404s an unknown id', async () => {
		const { deps } = makeDeps()
		const response = await handleApi(req('GET', '/api/runs/nope'), deps)
		expect(response.status).toBe(404)
	})

	test('cancel marks a running run failed; 409 once terminal, 404 unknown', async () => {
		const { deps } = makeDeps()
		await deps.repositories.registry.createApp({ id: 'a', repoUrl: 'r' })
		await deps.repositories.registry.upsertAppEnv(storedEnvironment('a', 'prod'))
		const runId = uuidv7()
		await deps.repositories.runs.createRun({ id: runId, appId: 'a', env: 'prod', ref: 'main', trigger: 'manual' })
		await deps.repositories.runs.markRunStarted(runId, logsKey(runId))

		const cancelled = await handleApi(req('POST', `/api/runs/${runId}/cancel`), deps)
		expect(cancelled.status).toBe(200)
		expect((await cancelled.json() as { status: string }).status).toBe('failed')
		expect((await deps.repositories.runs.getRun(runId))?.status).toBe('failed')

		// A second cancel on the now-terminal run is a 409.
		const again = await handleApi(req('POST', `/api/runs/${runId}/cancel`), deps)
		expect(again.status).toBe(409)

		// An unknown run is a 404.
		const unknown = await handleApi(req('POST', '/api/runs/nope/cancel'), deps)
		expect(unknown.status).toBe(404)
	})
})
