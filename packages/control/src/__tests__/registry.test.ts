import { ConflictError } from '@fabrika/app'
import { FABRIKA_IAM_APP_ID, FABRIKA_IAM_ISSUER, FRAMEWORK_VARIABLE_NAMES, isFrameworkVariableName } from '@fabrika/auth-core'
import { OPERATIONS_MANAGED_ENVIRONMENT_KEYS } from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE } from '@fabrika/operations-contract/releases'
import { uuidv7 } from '@fabrika/platform'
import type { ControlProvider, JsonValue, ProviderEnvelope, ProviderRegistrationInput } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { deleteAppUseCase, updateAppUseCase } from '../api/registry/apps'
import { type RegistryUseCaseContext } from '../api/registry/context'
import { deleteAppEnvUseCase, putAppEnvUseCase } from '../api/registry/environments'
import { registerAppUseCase } from '../api/registry/registration'
import { normalizeRegistration } from '../api/registry/registration'
import type { AnonymousReadability, CommitSource } from '../github/source/commit-files'
import { type ControlJobMessage, logsKey } from '../run-lifecycle'
import type { ControlRpcDeps } from '../services'
import { parseVaultRef, Vault } from '../vault'
import { memoryCommits } from './helpers/commits'
import { createHarness, type Harness } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'
import { fixtureRuns, makeFakeLock } from './helpers/lock'
import { rpcRequest, rpcResult } from './helpers/rpc'
import { testVaultKey } from './helpers/vault'

// Registry + onboarding row creation, and run-history reads, driven through the RPC
// router against the real schema (in-memory sqlite). An allow-all test authenticator lets us focus on
// the data path here; ACL is covered separately in acl.test.ts.

function makeDeps(
	opts: { provider?: ControlProvider; catalogChanged?: () => void } = {},
): { deps: ControlRpcDeps; queue: ControlJobMessage[]; logStore: Map<string, string>; sqlite: Harness['sqlite'] } {
	const { db, d1, sqlite } = createHarness()
	const queue: ControlJobMessage[] = []
	const logStore = new Map<string, string>()
	const vault = Vault.create(d1, testVaultKey())
	const deps: ControlRpcDeps = {
		repositories: db,
		vault: () => vault,
		auth: allowAllAuth(),
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
		provider: opts.provider ?? fakeProvider,
		// Stand in for the runner: mark the run failed (the real seam destroys the container + frees the lock).
		cancelRun: (run) => fixtureRuns(db.runs, makeFakeLock(db)).finish(run.id, 'failed').then(() => {}),
		...(opts.catalogChanged === undefined ? {} : { catalogChanged: opts.catalogChanged }),
	}
	return { deps, queue, logStore, sqlite }
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
	source: { binding: 'connection' },
}

/** A provider that CAN read its own artifact's declarations — the shape `declaredVariables` exists for. */
const declaringProvider: ControlProvider = {
	...fakeProvider,
	// Passthrough, unlike `fakeProvider`, which rewrites the artifact payload down to its image name.
	normalizeRegistration: (input) => input,
	declaredVariables: ({ artifact }) => {
		const declared = payloadObject(artifact)['declaredVars']
		return Array.isArray(declared) ? declared.filter((name): name is string => typeof name === 'string') : undefined
	},
}

const zeropsProvider: ControlProvider = {
	id: 'zerops',
	source: { binding: 'connection' },
	normalizeRegistration: (input) => {
		if (input.environment.target.provider !== 'zerops' || input.environment.artifact.provider !== 'zerops') {
			throw new Error('fake Zerops provider rejects foreign envelopes')
		}
		return input
	},
	deploy: () => Promise.resolve({ state: 'succeeded' }),
}

function insertSourceConnection(sqlite: Harness['sqlite'], connectionId: string, owner: string, installationId: number): void {
	sqlite.query(`INSERT INTO github_source_connections_keyed (
		connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, '123', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'selected', '[]', '[]', 'user-1', 1, 1, 1)`)
		.run(
			connectionId,
			`${connectionId}-app`,
			`https://github.com/apps/${connectionId}-app`,
			owner,
			`${connectionId}-app`,
			`vault:${connectionId}-credential`,
			`https://control.example/webhooks/github/${connectionId}`,
			`vault:${connectionId}`,
			installationId,
			owner.toLowerCase(),
		)
}

const zeropsRegistrationEnvelopes = (): { target: ProviderEnvelope; artifact: ProviderEnvelope } => ({
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
})

const registrationEnvelopes = (): { target: ProviderEnvelope; artifact: ProviderEnvelope } => ({
	target: { provider: 'harbor', version: 1, payload: { region: 'eu' } },
	artifact: { provider: 'harbor', version: 1, payload: { image: 'registry.example/app:v1' } },
})

const storedEnvironment = (
	appId: string,
	env: string,
	options: { domain?: string | null; publicOrigin?: string | null; triggerRef?: string | null } = {},
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

describe('onboarding + registry CRUD', () => {
	test('schedules every catalog-affecting mutation without letting a scheduling failure change the response', async () => {
		let scheduled = 0
		const { deps } = makeDeps({
			catalogChanged: () => {
				scheduled++
				throw new Error('operations unavailable')
			},
		})

		expect((await rpcResult(rpcRequest('apps.create', { id: 'app-a', repoUrl: 'https://github.com/acme/app-a' }), deps)).status).toBe(200)
		expect((await rpcResult(rpcRequest('apps.update', { appId: 'app-a', app: { defaultBranch: 'next' } }), deps)).status).toBe(200)
		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app-a', env: 'stage', environment: registrationEnvelopes() }), deps)).status)
			.toBe(200)
		expect((await rpcResult(rpcRequest('apps.environments.delete', { appId: 'app-a', env: 'stage' }), deps)).status).toBe(200)
		expect((await rpcResult(rpcRequest('apps.delete', { appId: 'app-a' }), deps)).status).toBe(200)
		expect(
			(await rpcResult(
				rpcRequest('register', {
					...registrationEnvelopes(),
					id: 'app-b',
					repoUrl: 'https://github.com/acme/app-b',
					env: 'stage',
				}),
				deps,
			)).status,
		).toBe(200)
		expect(scheduled).toBe(6)
	})

	test('normalizes and round-trips a third provider without a registry branch', async () => {
		const { deps } = makeDeps()
		await rpcResult(rpcRequest('apps.create', { id: 'harbor-app', repoUrl: 'https://github.com/acme/harbor-app' }), deps)
		const response = await rpcResult(
			rpcRequest('apps.environments.put', {
				appId: 'harbor-app',
				env: 'prod',
				environment: {
					domain: 'app.example.com',
					target: { provider: 'harbor', version: 1, payload: { region: ' EU-WEST ' } },
					artifact: { provider: 'harbor', version: 1, payload: { image: ' registry.example/app:v4 ' } },
				},
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

		const foreign = await rpcResult(
			rpcRequest('apps.environments.put', {
				appId: 'harbor-app',
				env: 'stage',
				environment: {
					target: { provider: 'other', version: 1, payload: { region: 'eu' } },
					artifact: { provider: 'harbor', version: 1, payload: { image: 'image' } },
				},
			}),
			deps,
		)
		expect(foreign.status).toBe(400)
		expect(await deps.repositories.registry.getAppEnv('harbor-app', 'stage')).toBeNull()
	})

	test('registerApp creates the app + its first app_env in one call', async () => {
		const { deps } = makeDeps()

		const response = await rpcResult(
			rpcRequest('register', {
				...registrationEnvelopes(),
				id: 'acme',
				repoUrl: 'https://github.com/acme/App.git',
				env: 'prod',
				domain: 'acme.example.com',
				publicOrigin: 'HTTPS://Public.Example.com:443',
				triggerRef: 'refs/heads/deploy/prod',
			}),
			deps,
		)
		expect(response.status).toBe(200)

		// App row exists with the NORMALIZED repo URL.
		const app = await deps.repositories.registry.getApp('acme')
		expect(app?.repo_url).toBe('github.com/acme/App')
		// And its prod env row, with the domain + trigger ref.
		const env = await deps.repositories.registry.getAppEnv('acme', 'prod')
		expect(env?.domain).toBe('acme.example.com')
		expect(env?.public_origin).toBe('https://public.example.com')
		expect(env?.trigger_ref).toBe('refs/heads/deploy/prod')
	})

	test('validates publicOrigin independently from domain and supports PUT preserve and clear semantics', async () => {
		const { deps } = makeDeps()
		await rpcResult(rpcRequest('apps.create', { id: 'origin-app', repoUrl: 'https://github.com/acme/origin-app' }), deps)

		const created = await rpcResult(
			rpcRequest('apps.environments.put', {
				appId: 'origin-app',
				env: 'prod',
				environment: {
					...registrationEnvelopes(),
					domain: 'provider.example.test',
					publicOrigin: 'http://localhost:18081',
				},
			}),
			deps,
		)
		expect(created.status).toBe(200)
		expect(await created.json()).toMatchObject({
			domain: 'provider.example.test',
			publicOrigin: 'http://localhost:18081',
		})

		const preserved = await rpcResult(
			rpcRequest('apps.environments.put', {
				appId: 'origin-app',
				env: 'prod',
				environment: { ...registrationEnvelopes(), domain: 'next.example.test' },
			}),
			deps,
		)
		expect(preserved.status).toBe(200)
		expect((await deps.repositories.registry.getAppEnv('origin-app', 'prod'))?.public_origin).toBe('http://localhost:18081')

		const cleared = await rpcResult(
			rpcRequest('apps.environments.put', { appId: 'origin-app', env: 'prod', environment: { ...registrationEnvelopes(), publicOrigin: null } }),
			deps,
		)
		expect(cleared.status).toBe(200)
		expect((await deps.repositories.registry.getAppEnv('origin-app', 'prod'))?.public_origin).toBeNull()
	})

	test('rejects malformed public origins without storing an environment', async () => {
		const { deps } = makeDeps()
		await rpcResult(rpcRequest('apps.create', { id: 'invalid-origin', repoUrl: 'https://github.com/acme/invalid-origin' }), deps)
		const invalid = [
			'https://user@example.com',
			'https://example.com/path',
			'https://example.com?query=1',
			'https://example.com#fragment',
			'ftp://example.com',
			'not-an-origin',
			' https://example.com',
		]

		for (const publicOrigin of invalid) {
			const response = await rpcResult(
				rpcRequest('apps.environments.put', { appId: 'invalid-origin', env: 'prod', environment: { ...registrationEnvelopes(), publicOrigin } }),
				deps,
			)
			expect(response.status).toBe(400)
			expect(await response.text()).not.toContain(publicOrigin)
			expect(await deps.repositories.registry.getAppEnv('invalid-origin', 'prod')).toBeNull()
		}
	})

	test('rejects a provider that changes the public origin during normalization', async () => {
		const provider: ControlProvider = {
			...fakeProvider,
			normalizeRegistration: (input) => ({
				app: input.app,
				environment: {
					...input.environment,
					publicOrigin: 'https://provider-overrode.example.test',
				},
			}),
		}
		const { deps } = makeDeps({ provider })
		await rpcResult(rpcRequest('apps.create', { id: 'origin-drift', repoUrl: 'https://github.com/acme/origin-drift' }), deps)

		const response = await rpcResult(
			rpcRequest('apps.environments.put', {
				appId: 'origin-drift',
				env: 'prod',
				environment: { ...registrationEnvelopes(), publicOrigin: 'https://public.example.test' },
			}),
			deps,
		)

		expect(response.status).toBe(400)
		expect(await deps.repositories.registry.getAppEnv('origin-drift', 'prod')).toBeNull()
	})

	test("registerApp binds the repository owner's connection when resolveInstallationId is set", async () => {
		const { deps, sqlite } = makeDeps()
		insertSourceConnection(sqlite, 'connection-acme', 'Acme', 424242)
		const response = await rpcResult(
			rpcRequest('register', {
				...registrationEnvelopes(),
				id: 'auto',
				repoUrl: 'https://github.com/acme/private',
				env: 'prod',
				resolveInstallationId: true,
			}),
			deps,
		)
		expect(response.status).toBe(200)
		expect(await deps.repositories.registry.getApp('auto')).toMatchObject({
			github_connection_id: 'connection-acme',
			github_installation_id: 424242,
		})
	})

	test('updateApp can back-fill the connection binding via Detect on an existing app', async () => {
		const { deps, sqlite } = makeDeps()
		insertSourceConnection(sqlite, 'connection-acme', 'Acme', 555)
		await rpcResult(rpcRequest('apps.create', { id: 'existing', repoUrl: 'https://github.com/acme/private' }), deps)
		expect((await deps.repositories.registry.getApp('existing'))?.github_installation_id).toBe(null)

		const patched = await rpcResult(rpcRequest('apps.update', { appId: 'existing', app: { resolveInstallationId: true } }), deps)
		expect(patched.status).toBe(200)
		expect(await deps.repositories.registry.getApp('existing')).toMatchObject({
			github_connection_id: 'connection-acme',
			github_installation_id: 555,
		})
	})

	test('a provider without private sources refuses a binding', async () => {
		const register = async (provider: ControlProvider, id: string) => {
			const { deps, sqlite } = makeDeps({ provider })
			insertSourceConnection(sqlite, 'connection-acme', 'Acme', 101)
			const response = await rpcResult(
				rpcRequest('register', { ...registrationEnvelopes(), id, repoUrl: 'https://github.com/acme/private', env: 'prod', resolveInstallationId: true }),
				deps,
			)
			return { status: response.status, app: await deps.repositories.registry.getApp(id) }
		}

		const connection = await register(fakeProvider, 'connection-app')
		expect(connection.app).toMatchObject({ github_connection_id: 'connection-acme', github_installation_id: 101 })
		const { source: _source, ...publicOnly } = fakeProvider
		const refused = await register(publicOnly, 'public-only-app')
		expect(refused.status).toBe(409)
		expect(refused.app).toBeNull()
	})

	test('Zerops onboarding persists the repository owner pair and rejects direct or two-step reassignment', async () => {
		const { deps, sqlite } = makeDeps({ provider: zeropsProvider })
		insertSourceConnection(sqlite, 'connection-acme', 'Acme', 101)
		insertSourceConnection(sqlite, 'connection-beta', 'Beta', 202)
		const context = {
			repositories: deps.repositories,
			provider: deps.provider,
			auth: deps.auth,
			signal: new AbortController().signal,
		}
		const registered = await registerAppUseCase(context, {
			id: 'beta-app',
			repoUrl: 'https://github.com/BETA/private-app.git',
			env: 'prod',
			resolveInstallationId: true,
			...zeropsRegistrationEnvelopes(),
		})
		expect(registered.app).toMatchObject({
			githubConnectionId: 'connection-beta',
			githubInstallationId: 202,
		})
		expect(await deps.repositories.registry.getApp('beta-app')).toMatchObject({
			github_connection_id: 'connection-beta',
			github_installation_id: 202,
		})
		await expect(updateAppUseCase(context, 'beta-app', {
			repoUrl: 'https://github.com/acme/private-app',
			resolveInstallationId: true,
		})).rejects.toMatchObject({ httpStatus: 409 })
		expect(await deps.repositories.registry.getApp('beta-app')).toMatchObject({
			repo_url: 'github.com/BETA/private-app',
			github_connection_id: 'connection-beta',
			github_installation_id: 202,
		})

		await expect(registerAppUseCase(context, {
			id: 'mismatch',
			repoUrl: 'https://github.com/beta/mismatch',
			env: 'prod',
			githubInstallationId: 101,
			...zeropsRegistrationEnvelopes(),
		})).rejects.toMatchObject({ httpStatus: 409 })
		await expect(registerAppUseCase(context, {
			id: 'unknown-owner',
			repoUrl: 'https://github.com/gamma/private',
			env: 'prod',
			resolveInstallationId: true,
			...zeropsRegistrationEnvelopes(),
		})).rejects.toMatchObject({ httpStatus: 409 })

		await expect(updateAppUseCase(context, 'beta-app', {
			repoUrl: 'https://github.com/gamma/public-app',
		})).rejects.toMatchObject({ httpStatus: 409 })
		await expect(updateAppUseCase(context, 'beta-app', {
			githubInstallationId: null,
		})).rejects.toMatchObject({ httpStatus: 409 })
		expect(await deps.repositories.registry.getApp('beta-app')).toMatchObject({
			repo_url: 'github.com/BETA/private-app',
			github_connection_id: 'connection-beta',
			github_installation_id: 202,
		})

		const publicRegistration = await registerAppUseCase(context, {
			id: 'public-app',
			repoUrl: 'https://github.com/gamma/public-app',
			env: 'prod',
			...zeropsRegistrationEnvelopes(),
		})
		expect(publicRegistration.app).toMatchObject({
			githubConnectionId: null,
			githubInstallationId: null,
		})
	})

	test('an anonymous source GitHub hides is refused before anything is created; a connected one is not probed', async () => {
		const { deps, sqlite } = makeDeps({ provider: zeropsProvider })
		insertSourceConnection(sqlite, 'connection-acme', 'Acme', 101)
		const context = (commits: CommitSource): RegistryUseCaseContext => ({
			repositories: deps.repositories,
			provider: deps.provider,
			auth: deps.auth,
			signal: new AbortController().signal,
			commits,
		})
		const anonymous = (id: string, readability: AnonymousReadability) =>
			registerAppUseCase(context(memoryCommits({}, readability)), {
				id,
				repoUrl: `https://github.com/gamma/${id}`,
				env: 'prod',
				githubInstallationId: null,
				...zeropsRegistrationEnvelopes(),
			})

		await expect(anonymous('hidden', 'unreadable')).rejects.toMatchObject({
			httpStatus: 409,
			message: expect.stringContaining('github.com/gamma/hidden is not publicly readable — connect the GitHub App in the console'),
		})
		expect(await deps.repositories.registry.getApp('hidden')).toBeNull()
		expect((await anonymous('visible', 'readable')).app.id).toBe('visible')
		// A probe that could not answer leaves the verdict to the deploy rather than refusing a working source.
		expect((await anonymous('unanswered', 'unknown')).app.id).toBe('unanswered')

		const unprobed: CommitSource = {
			...memoryCommits(),
			anonymousReadability: () => Promise.reject(new Error('a connected source must not be probed anonymously')),
		}
		const connected = await registerAppUseCase(context(unprobed), {
			id: 'connected',
			repoUrl: 'https://github.com/acme/private-app',
			env: 'prod',
			resolveInstallationId: true,
			...zeropsRegistrationEnvelopes(),
		})
		expect(connected.app.githubConnectionId).toBe('connection-acme')
	})

	test('registerApp rejects a missing field (400) and a duplicate id (409)', async () => {
		const { deps } = makeDeps()
		const missing = await rpcResult(rpcRequest('register', { ...registrationEnvelopes(), id: 'x', repoUrl: 'r' }), deps)
		expect(missing.status).toBe(400) // env required

		await rpcResult(rpcRequest('register', { ...registrationEnvelopes(), id: 'dup', repoUrl: 'r', env: 'prod' }), deps)
		const dup = await rpcResult(rpcRequest('register', { ...registrationEnvelopes(), id: 'dup', repoUrl: 'r', env: 'stage' }), deps)
		expect(dup.status).toBe(409)
	})

	test('apps / app_envs / secrets CRUD round-trips', async () => {
		const { deps } = makeDeps()
		await rpcResult(rpcRequest('apps.create', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)

		// app_env upsert
		const putEnv = await rpcResult(
			rpcRequest('apps.environments.put', {
				appId: 'app',
				env: 'stage',
				environment: { ...registrationEnvelopes(), triggerRef: 'refs/heads/deploy/stage' },
			}),
			deps,
		)
		expect(putEnv.status).toBe(200)

		// secret upsert: the value is sealed and only its vault ref comes back
		const putSecret = await rpcResult(rpcRequest('apps.secrets.put', { appId: 'app', secret: { name: 'API_KEY', value: 'the-api-key' } }), deps)
		expect(putSecret.status).toBe(200)
		const secret = (await putSecret.json()) as { valueRef: string }
		expect(parseVaultRef(secret.valueRef)).not.toBeNull()

		// list secrets
		const listSecrets = await rpcResult(rpcRequest('apps.secrets.list', { appId: 'app' }), deps)
		const secrets = (await listSecrets.json()) as { items: unknown[] }
		expect(secrets.items).toHaveLength(1)

		// delete secret (all-env layer)
		const delSecret = await rpcResult(rpcRequest('apps.secrets.delete', { appId: 'app', name: 'API_KEY' }), deps)
		expect(delSecret.status).toBe(200)
		expect(await deps.repositories.registry.listAppSecrets('app')).toHaveLength(0)

		// delete app cascades its env
		const delApp = await rpcResult(rpcRequest('apps.delete', { appId: 'app' }), deps)
		expect(delApp.status).toBe(200)
		expect(await deps.repositories.registry.getAppEnv('app', 'stage')).toBeNull()
	})

	test('app_vars CRUD round-trips (plaintext value, readable — unlike secrets)', async () => {
		const { deps } = makeDeps()
		await rpcResult(rpcRequest('apps.create', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)

		// var upsert (plaintext config value — any name the app declares in `pipeline.vars`)
		const putVar = await rpcResult(
			rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'EXAMPLE_TEAM', value: 'https://contember.cloudflareaccess.com' } }),
			deps,
		)
		expect(putVar.status).toBe(200)
		// UNLIKE secrets, the VALUE is returned (vars are non-secret config).
		const v = (await putVar.json()) as { name: string; value: string }
		expect(v.value).toBe('https://contember.cloudflareaccess.com')

		// missing value → 400
		const bad = await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'X' } }), deps)
		expect(bad.status).toBe(400)
		for (const name of [...OPERATIONS_MANAGED_ENVIRONMENT_KEYS, FABRIKA_RELEASE]) {
			const reserved = await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name, value: 'user-owned' } }), deps)
			expect(reserved.status).toBe(400)
		}

		// list vars
		const listVars = await rpcResult(rpcRequest('apps.variables.list', { appId: 'app' }), deps)
		const vars = (await listVars.json()) as { items: unknown[] }
		expect(vars.items).toHaveLength(1)

		// delete var (all-env layer)
		const delVar = await rpcResult(rpcRequest('apps.variables.delete', { appId: 'app', name: 'EXAMPLE_TEAM' }), deps)
		expect(delVar.status).toBe(200)
		expect(await deps.repositories.registry.listAppVars('app')).toHaveLength(0)
	})

	test('refuses a variable the artifact does not declare, and says where to declare it', async () => {
		// ADR-0035: a variable is an input to the app's own config, so a name the config never reads is
		// stored and then ignored. A provider that can read its artifact's declarations refuses it here.
		const { deps } = makeDeps({ provider: declaringProvider })
		await rpcResult(rpcRequest('apps.create', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)

		// Before any environment exists there is nothing to check against, so the write stands.
		expect((await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'ANYTHING', value: 'v' } }), deps)).status).toBe(200)

		const registered = await rpcResult(
			rpcRequest('apps.environments.put', {
				appId: 'app',
				env: 'prod',
				environment: {
					target: { provider: 'harbor', version: 1, payload: { region: 'eu' } },
					artifact: { provider: 'harbor', version: 1, payload: { image: 'registry.example/app:v1', declaredVars: ['TEAM'] } },
				},
			}),
			deps,
		)
		expect(registered.status).toBe(200)

		expect((await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'TEAM', value: 'core' } }), deps)).status).toBe(200)
		const refused = await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'UNDECLARED', value: 'v' } }), deps)
		expect(refused.status).toBe(400)
		expect(((await refused.json()) as { error: string }).error).toContain('pipeline.vars')

		// The reserved issuer is refused as managed, not as undeclared.
		const managed = await rpcResult(
			rpcRequest('apps.variables.put', { appId: 'app', variable: { name: FABRIKA_IAM_ISSUER, value: 'https://attacker.example' } }),
			deps,
		)
		expect(managed.status).toBe(400)
		expect(((await managed.json()) as { error: string }).error).toContain('managed by Fabrika')
	})

	test('a provider that cannot read its artifact constrains nothing', async () => {
		// `undefined` is the honest answer for an artifact that names a config path in the repository;
		// guessing an empty set there would refuse a variable that works.
		const { deps } = makeDeps()
		await rpcResult(rpcRequest('apps.create', { id: 'app', repoUrl: 'https://github.com/acme/app' }), deps)
		await rpcResult(
			rpcRequest('apps.environments.put', {
				appId: 'app',
				env: 'prod',
				environment: {
					target: { provider: 'harbor', version: 1, payload: { region: 'eu' } },
					artifact: { provider: 'harbor', version: 1, payload: { image: 'registry.example/app:v1' } },
				},
			}),
			deps,
		)
		expect((await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'WHATEVER', value: 'v' } }), deps)).status).toBe(200)
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
		await deps.repositories.runs.createRun({ id: r1, appId: 'a', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
		const r2 = uuidv7()
		await deps.repositories.runs.createRun({ id: r2, appId: 'b', env: 'prod', ref: 'main', trigger: 'webhook', actor: 'user:test' })

		const all = await rpcResult(rpcRequest('runs.list', {}), deps)
		const allBody = (await all.json()) as { items: { id: string }[] }
		expect(allBody.items).toHaveLength(2)
		// Returned in descending id order. UUIDv7 carries the RFC 9562 §6.2 monotonic counter, so r2 > r1
		// even though the two were minted inside one millisecond — the exact order is assertable.
		expect(allBody.items.map((i) => i.id)).toEqual([r2, r1])

		const filtered = await rpcResult(rpcRequest('runs.list', { appId: 'a' }), deps)
		const filteredBody = (await filtered.json()) as { items: { id: string }[] }
		expect(filteredBody.items).toHaveLength(1)
		expect(filteredBody.items[0]?.id).toBe(r1)
	})

	test('getRunLog reads + parses the NDJSON log from R2', async () => {
		const { deps, logStore } = makeDeps()
		await deps.repositories.registry.createApp({ id: 'a', repoUrl: 'r' })
		await deps.repositories.registry.upsertAppEnv(storedEnvironment('a', 'prod'))
		const runId = uuidv7()
		await deps.repositories.runs.createRun({ id: runId, appId: 'a', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
		await fixtureRuns(deps.repositories.runs, makeFakeLock(deps.repositories)).start(runId, logsKey(runId))
		// Stage two log lines in the fake R2 under the run's log key.
		logStore.set(
			logsKey(runId),
			[JSON.stringify({ ts: 1, stream: 'meta', text: 'Cloning' }), JSON.stringify({ ts: 2, stream: 'stdout', text: 'done' })].join('\n'),
		)

		const response = await rpcResult(rpcRequest('runs.log', { runId }), deps)
		expect(response.status).toBe(200)
		const body = (await response.json()) as { lines: { text: string }[] }
		expect(body.lines).toHaveLength(2)
		expect(body.lines[1]?.text).toBe('done')

		// tail with a cursor returns only the new lines + a done flag once terminal.
		const tail = await rpcResult(rpcRequest('runs.tail', { runId, after: 1 }), deps)
		const tailBody = (await tail.json()) as { lines: unknown[]; cursor: number; done: boolean }
		expect(tailBody.lines).toHaveLength(1)
		expect(tailBody.cursor).toBe(2)
	})

	test('getRun 404s an unknown id', async () => {
		const { deps } = makeDeps()
		const response = await rpcResult(rpcRequest('runs.get', { runId: 'nope' }), deps)
		expect(response.status).toBe(404)
	})

	test('cancel marks a running run failed; 409 once terminal, 404 unknown', async () => {
		const { deps } = makeDeps()
		await deps.repositories.registry.createApp({ id: 'a', repoUrl: 'r' })
		await deps.repositories.registry.upsertAppEnv(storedEnvironment('a', 'prod'))
		const runId = uuidv7()
		await deps.repositories.runs.createRun({ id: runId, appId: 'a', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
		await fixtureRuns(deps.repositories.runs, makeFakeLock(deps.repositories)).start(runId, logsKey(runId))

		const cancelled = await rpcResult(rpcRequest('runs.cancel', { runId }), deps)
		expect(cancelled.status).toBe(200)
		expect((await cancelled.json() as { status: string }).status).toBe('failed')
		expect((await deps.repositories.runs.getRun(runId))?.status).toBe('failed')

		// A second cancel on the now-terminal run is a 409.
		const again = await rpcResult(rpcRequest('runs.cancel', { runId }), deps)
		expect(again.status).toBe(409)

		// An unknown run is a 404.
		const unknown = await rpcResult(rpcRequest('runs.cancel', { runId: 'nope' }), deps)
		expect(unknown.status).toBe(404)
	})
})

describe('platform-owned names, bounded values, and literal hosts', () => {
	async function seededApp(): Promise<ReturnType<typeof makeDeps>> {
		const made = makeDeps()
		await rpcResult(rpcRequest('apps.create', { id: 'app', repoUrl: 'https://github.com/acme/app' }), made.deps)
		return made
	}

	test('a reserved name is refused on the SECRET surface, exactly as it is on the variable surface', async () => {
		const { deps } = await seededApp()
		for (const name of FRAMEWORK_VARIABLE_NAMES) {
			const refused = await rpcResult(rpcRequest('apps.secrets.put', { appId: 'app', secret: { name, value: 'x' } }), deps)
			expect(`${name}: ${refused.status}`).toBe(`${name}: 400`)
			expect(((await refused.json()) as { error: string }).error).toContain('managed by Fabrika')
		}
		expect(await deps.repositories.registry.listAppSecrets('app')).toEqual([])
	})

	test('a variable or secret value that references a framework-only variable is refused, naming only the reference', async () => {
		const { deps } = await seededApp()
		for (const value of ['${RUNTIME_FABRIKA_PROXY_SECRET}', 'x-${api_FABRIKA_APP_DATABASE_URL}', '${FABRIKA_PROXY_${SUFFIX}}']) {
			const variable = await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'COPY', value } }), deps)
			expect(variable.status).toBe(400)
			expect(((await variable.json()) as { error: string }).error).toContain('references the Fabrika-managed variable')
			const secret = await rpcResult(rpcRequest('apps.secrets.put', { appId: 'app', secret: { name: 'COPY', value } }), deps)
			expect(secret.status).toBe(400)
		}
		expect(await deps.repositories.registry.listAppSecrets('app')).toEqual([])
		expect(await deps.repositories.registry.listAppVars('app')).toEqual([])
	})

	test('every name a deploy writes into the managed environment is in the one framework-only list', () => {
		for (const name of [FABRIKA_IAM_ISSUER, FABRIKA_IAM_APP_ID, FABRIKA_RELEASE, ...OPERATIONS_MANAGED_ENVIRONMENT_KEYS]) {
			expect(`${name}: ${isFrameworkVariableName(name)}`).toBe(`${name}: true`)
		}
	})

	test('a written value is sealed in the vault — the row holds only its ref, even when the value looks like a ref', async () => {
		const { deps, sqlite } = await seededApp()
		for (
			const [name, value] of [['API_KEY', 'sk-live-plaintext'], ['LOOKS_LIKE_REF', 'literal:sk-live-plaintext'], [
				'VAULT_LIKE',
				'vault:01a00000-0000-7000-8000-000000000000',
			]]
		) {
			const put = await rpcResult(rpcRequest('apps.secrets.put', { appId: 'app', secret: { name, value } }), deps)
			expect(`${name}: ${put.status}`).toBe(`${name}: 200`)
			expect(await put.text()).not.toContain('sk-live-plaintext')
		}

		const rows = await deps.repositories.registry.listAppSecrets('app')
		expect(rows).toHaveLength(3)
		for (const row of rows) expect(parseVaultRef(row.value_ref)).not.toBeNull()
		expect(rows.some((row) => row.value_ref === 'vault:01a00000-0000-7000-8000-000000000000')).toBe(false)
		expect(JSON.stringify(sqlite.query('SELECT * FROM app_secrets').all())).not.toContain('sk-live-plaintext')
		const vault = await deps.vault?.()
		const stored = rows.find((row) => row.name === 'LOOKS_LIKE_REF')
		expect(stored === undefined ? undefined : await vault?.getSecret(stored.value_ref)).toBe('literal:sk-live-plaintext')
	})

	test('a legacy non-vault row is listed as legacy with no ref, so plaintext it may hold is never echoed', async () => {
		const { deps } = await seededApp()
		await deps.repositories.registry.upsertAppSecret({ appId: 'app', env: null, name: 'OLD', valueRef: 'literal:sk-live-plaintext' })
		await rpcResult(rpcRequest('apps.secrets.put', { appId: 'app', secret: { name: 'NEW', value: 'fresh' } }), deps)

		const listed = await rpcResult(rpcRequest('apps.secrets.list', { appId: 'app' }), deps)
		const body = await listed.text()
		expect(body).not.toContain('sk-live-plaintext')
		const items = (JSON.parse(body) as { items: { name: string; storage: string; valueRef: string | null }[] }).items
		expect(items.find((item) => item.name === 'OLD')).toMatchObject({ storage: 'legacy', valueRef: null })
		const fresh = items.find((item) => item.name === 'NEW')
		expect(fresh?.storage).toBe('vault')
		expect(parseVaultRef(fresh?.valueRef ?? '')).not.toBeNull()
	})

	test('a raw valueRef input is no longer accepted', async () => {
		const { deps } = await seededApp()
		const refused = await rpcResult(rpcRequest('apps.secrets.put', { appId: 'app', secret: { name: 'API_KEY', valueRef: 'literal:x' } }), deps)
		expect(refused.status).toBe(400)
		expect(await deps.repositories.registry.listAppSecrets('app')).toEqual([])
	})

	test('a variable value must be one bounded line', async () => {
		const { deps } = await seededApp()
		const multiline = await rpcResult(
			rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'TAG', value: 'v1"\n  hostname: evil' } }),
			deps,
		)
		expect(multiline.status).toBe(400)
		expect(((await multiline.json()) as { error: string }).error).toContain('single line')

		expect((await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'TAG', value: `v\r1` } }), deps)).status).toBe(400)
		expect((await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'TAG', value: 'a'.repeat(4097) } }), deps)).status).toBe(
			400,
		)

		// A YAML 1.1 reader ends a line on NEL/LS/PS and refuses a raw C1 control, so "one line" covers them too.
		for (const character of ['\u0085', '\u2028', '\u2029', '\u0080', '\u009f', '\u007f']) {
			const label = `U+${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`
			const refused = await rpcResult(
				rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'TAG', value: `v1${character}  - hostname: evil` } }),
				deps,
			)
			expect(`${label}: ${refused.status}`).toBe(`${label}: 400`)
			expect(`${label}: ${((await refused.json()) as { error: string }).error}`).toContain('single line')
		}

		// The bound itself, a tab, and an ordinary non-ASCII space are accepted.
		expect((await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'TAG', value: 'a'.repeat(4096) } }), deps)).status).toBe(
			200,
		)
		expect((await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'TAG', value: 'a\tb' } }), deps)).status).toBe(200)
		expect((await rpcResult(rpcRequest('apps.variables.put', { appId: 'app', variable: { name: 'TAG', value: 'a\u00a0b' } }), deps)).status).toBe(200)
	})

	test('@ is reserved in an app id and an environment name, because it joins them into the IAM application id', async () => {
		const { deps } = await seededApp()
		const app = await rpcResult(rpcRequest('apps.create', { id: 'no@tes', repoUrl: 'https://github.com/acme/notes' }), deps)
		expect(app.status).toBe(400)
		expect(((await app.json()) as { error: string }).error).toContain("must not contain '@'")
		const environment = await rpcResult(
			rpcRequest('apps.environments.put', { appId: 'app', env: 'pr@od', environment: registrationEnvelopes() }),
			deps,
		)
		expect(environment.status).toBe(400)
		expect(await deps.repositories.registry.listAppEnvs('app')).toEqual([])
	})

	const BAD_DOMAINS = ['*', '*.apps.example.com', 'apps.example.com:8080', 'https://apps.example.com', 'apps.example.com/x']

	test('a domain must be a literal host the proxy can route on', async () => {
		const { deps } = await seededApp()
		for (const domain of BAD_DOMAINS) {
			const refused = await rpcResult(
				rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: { ...registrationEnvelopes(), domain } }),
				deps,
			)
			expect(`${domain}: ${refused.status}`).toBe(`${domain}: 400`)
			expect(((await refused.json()) as { error: string }).error).toContain('literal hostname')
		}
		expect(
			(await rpcResult(
				rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: { ...registrationEnvelopes(), domain: 'Apps.Example.com' } }),
				deps,
			)).status,
		).toBe(200)
	})

	test('the domain use case independently refuses non-literal hosts', async () => {
		const { deps } = await seededApp()
		const context: RegistryUseCaseContext = {
			repositories: deps.repositories,
			provider: deps.provider,
			auth: deps.auth,
			signal: new AbortController().signal,
		}
		for (const domain of BAD_DOMAINS) {
			await expect(putAppEnvUseCase(context, 'app', 'prod', { ...registrationEnvelopes(), domain }))
				.rejects.toMatchObject({ httpStatus: 400 })
			await expect(registerAppUseCase(context, {
				id: `fresh-${BAD_DOMAINS.indexOf(domain)}`,
				repoUrl: 'https://github.com/acme/app',
				env: 'prod',
				domain,
				...registrationEnvelopes(),
			})).rejects.toMatchObject({ httpStatus: 400 })
		}
		expect(await deps.repositories.registry.getAppEnv('app', 'prod')).toBeNull()
		expect(await deps.repositories.registry.getApp('fresh-0')).toBeNull()
	})
})

const CONSOLE_ORIGIN = 'https://control.example.test'

function consoleRequest(headers: Record<string, string> = {}): Request {
	return new Request(`${CONSOLE_ORIGIN}/api/rpc`, { method: 'POST', headers: { Origin: CONSOLE_ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...headers } })
}

describe('the namespace proxy follows the registry', () => {
	interface ProxyRecording {
		synced: string[]
		fail?: string
	}

	/** The default fake provider owns no namespaces; the proxy only exists where they do. */
	const namespacedProvider: ControlProvider = {
		...fakeProvider,
		namespaces: {
			normalize: (namespace) => namespace,
			namespaceResourceClaims: () => ['service:proxy'],
			registrationResourceClaims: (registration) => [`service:${registration.app.id}`],
			provision: (input) => Promise.resolve(input.namespace),
			reconcile: (input) => Promise.resolve(input.namespace),
		},
	}

	// A person in the console: deleting the protected `prod` environment takes one.
	function context(deps: ControlRpcDeps, recording: ProxyRecording): RegistryUseCaseContext {
		return {
			repositories: deps.repositories,
			provider: deps.provider,
			auth: deps.auth,
			signal: new AbortController().signal,
			admission: { request: consoleRequest() },
			namespaceProxyChanged: (namespaceId) => {
				recording.synced.push(namespaceId)
				return recording.fail === namespaceId ? Promise.reject(new Error('platform said no')) : Promise.resolve()
			},
		}
	}

	/** One namespace per environment: the claim FK pins `(namespace, provider, env)` together. */
	async function seedNamespaces(deps: ControlRpcDeps): Promise<void> {
		for (const env of ['prod', 'stage']) {
			await deps.repositories.registry.createDeploymentNamespaceWithResourceClaims({
				id: `apps-${env}`,
				env,
				provider: 'harbor',
				exclusiveAppId: null,
				providerTargetJson: JSON.stringify(registrationEnvelopes().target),
				state: 'ready',
			}, ['service:proxy'])
		}
	}

	// Seeded WITHOUT resource claims: the environment a delete can actually remove. `seedClaimedApp` is
	// the other half — the claim's owner FK is `ON DELETE RESTRICT`, so a claimed one is refused.
	async function seedRoutedApp(deps: ControlRpcDeps, appId: string, envs: string[]): Promise<void> {
		await deps.repositories.registry.createApp({ id: appId, repoUrl: `github.com/acme/${appId}` })
		for (const env of envs) {
			await deps.repositories.registry.upsertAppEnv({
				...storedEnvironment(appId, env, { domain: `${appId}-${env}.example.com` }),
				namespaceId: `apps-${env}`,
			})
		}
	}

	/** What a Zerops app environment is: the row plus the resource claims its registration acquired. */
	async function seedClaimedApp(deps: ControlRpcDeps, appId: string, envs: string[]): Promise<void> {
		await deps.repositories.registry.createApp({ id: appId, repoUrl: `github.com/acme/${appId}` })
		for (const env of envs) {
			await deps.repositories.registry.upsertAppEnvWithNamespaceResourceClaims({
				...storedEnvironment(appId, env, { domain: `${appId}-${env}.example.com` }),
				namespaceId: `apps-${env}`,
			}, [`service:${appId}`, `service:${appId}-db`])
		}
	}

	/** A refused delete must audit nothing, so the audit calls are what proves the order. */
	function auditing(base: RegistryUseCaseContext, audited: string[]): RegistryUseCaseContext {
		return {
			...base,
			auth: {
				...base.auth,
				audit: (event) => {
					audited.push(event.action)
					return Promise.resolve()
				},
			},
		}
	}

	test('deleting an app republishes every namespace that routed one of its environments', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		await seedRoutedApp(deps, 'notes', ['prod', 'stage'])
		const recording: ProxyRecording = { synced: [] }

		expect(await deleteAppUseCase(context(deps, recording), 'notes')).toEqual({ ok: true })
		expect(recording.synced.sort()).toEqual(['apps-prod', 'apps-stage'])
	})

	test('deleting one environment republishes only the namespace it sat in', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		await seedRoutedApp(deps, 'notes', ['prod', 'stage'])
		const recording: ProxyRecording = { synced: [] }

		expect(await deleteAppEnvUseCase(context(deps, recording), 'notes', 'prod')).toEqual({ ok: true })
		expect(recording.synced).toEqual(['apps-prod'])
	})

	test('a failed republish is reported, and the registry change stands', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		await seedRoutedApp(deps, 'notes', ['prod'])
		const recording: ProxyRecording = { synced: [], fail: 'apps-prod' }

		await expect(deleteAppUseCase(context(deps, recording), 'notes')).rejects.toMatchObject({ httpStatus: 502 })
		expect(await deps.repositories.registry.getApp('notes')).toBeNull()
	})

	test('moving an environment republishes the namespace that loses it AND the one that gains it', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		// A second `prod` namespace, so the move is between two proxies rather than across environments.
		await deps.repositories.registry.createDeploymentNamespaceWithResourceClaims({
			id: 'spare-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(registrationEnvelopes().target),
			state: 'ready',
		}, ['service:proxy'])
		await seedRoutedApp(deps, 'notes', ['prod'])
		const recording: ProxyRecording = { synced: [] }

		await putAppEnvUseCase(context(deps, recording), 'notes', 'prod', {
			...registrationEnvelopes(),
			domain: 'notes-prod.example.com',
			namespaceId: 'spare-prod',
		})

		expect(recording.synced.sort()).toEqual(['apps-prod', 'spare-prod'])
		expect((await deps.repositories.registry.getAppEnv('notes', 'prod'))?.namespace_id).toBe('spare-prod')
	})

	test('a rewritten artifact republishes too — the manifest carries its upstream and gates', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		await seedRoutedApp(deps, 'notes', ['prod'])
		const recording: ProxyRecording = { synced: [] }

		await putAppEnvUseCase(context(deps, recording), 'notes', 'prod', {
			target: registrationEnvelopes().target,
			artifact: { provider: 'harbor', version: 1, payload: { image: 'registry.example/app:v2' } },
			domain: 'notes-prod.example.com',
			namespaceId: 'apps-prod',
		})

		expect(recording.synced).toEqual(['apps-prod'])
	})

	test('every affected proxy is attempted, and the failures are reported together', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		await seedRoutedApp(deps, 'notes', ['prod', 'stage'])
		const recording: ProxyRecording = { synced: [], fail: 'apps-prod' }

		await expect(deleteAppUseCase(context(deps, recording), 'notes')).rejects.toMatchObject({ httpStatus: 502 })
		// The second namespace is still republished even though the first refused.
		expect(recording.synced.sort()).toEqual(['apps-prod', 'apps-stage'])
	})

	test('deleting an app its resource claims hold is refused, naming every namespace and key', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		await seedClaimedApp(deps, 'notes', ['prod', 'stage'])
		const recording: ProxyRecording = { synced: [] }
		const audited: string[] = []

		await expect(deleteAppUseCase(auditing(context(deps, recording), audited), 'notes')).rejects.toMatchObject({
			httpStatus: 409,
			message: 'app notes still holds deployment namespace resource claims: '
				+ 'apps-prod (service:notes, service:notes-db), apps-stage (service:notes, service:notes-db)',
		})
		expect(await deps.repositories.registry.getApp('notes')).not.toBeNull()
		expect(recording.synced).toEqual([])
		expect(audited).toEqual([])
	})

	test('deleting one environment its resource claims hold is refused, naming only that namespace', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		await seedClaimedApp(deps, 'notes', ['prod', 'stage'])
		const recording: ProxyRecording = { synced: [] }
		const audited: string[] = []

		await expect(deleteAppEnvUseCase(auditing(context(deps, recording), audited), 'notes', 'prod')).rejects.toMatchObject({
			httpStatus: 409,
			message: 'app env notes/prod still holds deployment namespace resource claims: apps-prod (service:notes, service:notes-db)',
		})
		expect(await deps.repositories.registry.getAppEnv('notes', 'prod')).not.toBeNull()
		expect(recording.synced).toEqual([])
		expect(audited).toEqual([])
	})

	test('the refusal leaves the unclaimed paths alone: an environment deletes, a missing app is 404', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		await seedRoutedApp(deps, 'notes', ['prod', 'stage'])
		const recording: ProxyRecording = { synced: [] }

		expect(await deleteAppEnvUseCase(context(deps, recording), 'notes', 'prod')).toEqual({ ok: true })
		expect(await deleteAppUseCase(context(deps, recording), 'notes')).toEqual({ ok: true })
		await expect(deleteAppUseCase(context(deps, recording), 'ghost')).rejects.toMatchObject({ httpStatus: 404 })
	})

	test('a renamed host republishes; an edit the manifest does not read republishes nothing', async () => {
		const { deps } = makeDeps({ provider: namespacedProvider })
		await seedNamespaces(deps)
		await seedRoutedApp(deps, 'notes', ['prod'])
		const recording: ProxyRecording = { synced: [] }
		const environment = { ...registrationEnvelopes(), namespaceId: 'apps-prod' }

		await putAppEnvUseCase(context(deps, recording), 'notes', 'prod', { ...environment, domain: 'renamed.example.com' })
		expect(recording.synced).toEqual(['apps-prod'])

		recording.synced.length = 0
		await putAppEnvUseCase(context(deps, recording), 'notes', 'prod', {
			...environment,
			domain: 'renamed.example.com',
			triggerRef: 'refs/tags/v*',
		})
		expect(recording.synced).toEqual([])
	})
})

describe('provider registration normalization errors', () => {
	const envelope: ProviderEnvelope = { provider: 'harbor', version: 1, payload: {} }
	const app = { id: 'app', source: { repoUrl: 'github.com/acme/app', ref: 'main' } }
	const environment = { appId: 'app', env: 'prod', target: envelope, artifact: envelope }
	const throwing = (cause: unknown): ControlProvider => ({
		id: 'harbor',
		normalizeRegistration: () => {
			throw cause
		},
		deploy: () => Promise.resolve({ state: 'succeeded' }),
	})

	test('a structural provider error keeps its own status', () => {
		expect(() => normalizeRegistration(throwing(new ConflictError('already claimed')), app, environment)).toThrow(
			expect.objectContaining({ httpStatus: 409, type: 'conflict', message: 'already claimed' }),
		)
	})

	test('any other provider error becomes a 400 with its message', () => {
		expect(() => normalizeRegistration(throwing(new Error('bad target')), app, environment)).toThrow(
			expect.objectContaining({ httpStatus: 400, type: 'bad_request', message: 'bad target' }),
		)
	})
})
