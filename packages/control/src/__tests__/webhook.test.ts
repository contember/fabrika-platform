import { describe, expect, test } from 'bun:test'
import { ConnectionWebhookVerifier, normalizeRepoUrl } from '../github/triggers/push-event'
import { handleWebhook, type WebhookDeps } from '../github/triggers/webhook'
import type { DeployJobMessage } from '../run-lifecycle'
import { createHarness, pushWebhookRequest, signWebhook } from './helpers/harness'
import { providerEnvironment } from './helpers/provider'

// The webhook is the one unauthenticated route, authenticated by HMAC with the route's connection secret. These tests
// exercise: (1) signature verification (good/bad), (2) repo+ref → (app, env) mapping driving run
// creation + enqueue, (3) the verified-but-unsubscribed no-op. The real verifier runs the HMAC check.

const SECRET = 'webhook-test-secret'
const CONNECTION_ID = 'connection-a'
const verifier = new ConnectionWebhookVerifier({ getSecret: () => Promise.resolve(SECRET) })

/** A tiny in-memory queue capturing enqueued messages. */
function makeQueue(): { sent: DeployJobMessage[]; send(message: DeployJobMessage): Promise<void> } {
	const sent: DeployJobMessage[] = []
	return {
		sent,
		send(m: DeployJobMessage): Promise<void> {
			sent.push(m)
			return Promise.resolve()
		},
	}
}

function insertConnection(
	sqlite: ReturnType<typeof createHarness>['sqlite'],
	connectionId: string,
	owner: string,
	installationId: number,
): void {
	sqlite.query(`INSERT INTO github_source_connections_keyed (
		connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'all', '[]', '[]', 'test', 1, 1, 1)`)
		.run(
			connectionId,
			`${connectionId}-app-id`,
			`${connectionId}-app`,
			`https://github.com/apps/${connectionId}-app`,
			owner,
			`${connectionId}-app`,
			`vault:${connectionId}-credential`,
			`https://control.test/webhooks/github/${connectionId}`,
			`vault:${connectionId}-webhook`,
			installationId,
			owner,
		)
}

async function seedZeropsApp(
	db: ReturnType<typeof createHarness>['db'],
	input: { id: string; repoUrl: string; connectionId: string; installationId: number },
): Promise<void> {
	await db.registry.createApp({
		id: input.id,
		repoUrl: normalizeRepoUrl(input.repoUrl),
		githubConnectionId: input.connectionId,
		githubInstallationId: input.installationId,
	})
	await db.registry.upsertAppEnv({
		appId: input.id,
		env: 'prod',
		namespaceId: null,
		provider: 'zerops',
		providerTargetJson: '{}',
		providerArtifactJson: '{}',
		triggerRef: 'refs/heads/deploy/prod',
	})
}

/**
 * Seed a connection + app + app_env with a trigger ref pointing at `prod`. Stores the NORMALIZED repo
 * URL (the handlers normalize on write; here we seed the Db directly, so we normalize explicitly).
 */
async function seedRegistry({ db, sqlite }: ReturnType<typeof createHarness>, cloneUrl: string): Promise<void> {
	insertConnection(sqlite, CONNECTION_ID, 'acme', 42)
	await db.registry.createApp({ id: 'app', repoUrl: normalizeRepoUrl(cloneUrl), githubConnectionId: CONNECTION_ID, githubInstallationId: 42 })
	await db.registry.upsertAppEnv(providerEnvironment('app', 'prod', { triggerRef: 'refs/heads/deploy/prod' }))
}

describe('handleWebhook (HMAC + ref→env)', () => {
	test('a valid signature on a subscribed ref creates a pending run + enqueues it', async () => {
		const harness = createHarness()
		const { db } = harness
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(harness, cloneUrl)
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, after: 'sha-1', installationId: 42, secret: SECRET })

		const response = await handleWebhook(request, {
			repositories: db,
			verifier,
			queue,
			connectionId: CONNECTION_ID,
		})

		expect(response.status).toBe(200)
		const body = (await response.json()) as { triggered: string[] }
		expect(body.triggered).toHaveLength(1)

		// The run row exists, pending, trigger=webhook, with the pushed commit.
		const run = await db.runs.getRun(body.triggered[0]!)
		expect(run).not.toBeNull()
		expect(run?.status).toBe('pending')
		expect(run?.trigger).toBe('webhook')
		expect(run?.env).toBe('prod')
		expect(run?.commit_sha).toBe('sha-1')
		// And it was enqueued.
		expect(queue.sent).toEqual([{ runId: body.triggered[0]! }])
	})

	test('a bad signature is rejected (401) and creates no run', async () => {
		const harness = createHarness()
		const { db } = harness
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(harness, cloneUrl)
		const queue = makeQueue()
		const request = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl,
			installationId: 42,
			secret: SECRET,
			signatureOverride: 'sha256=deadbeef',
		})

		const response = await handleWebhook(request, {
			repositories: db,
			verifier,
			queue,
			connectionId: CONNECTION_ID,
		})

		expect(response.status).toBe(401)
		expect(queue.sent).toHaveLength(0)
		expect(await db.runs.listRuns({ limit: 10 })).toHaveLength(0)
	})

	test('a signature for the WRONG secret is rejected (401)', async () => {
		const harness = createHarness()
		const { db } = harness
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(harness, cloneUrl)
		const queue = makeQueue()
		// Sign with a different secret than the source verifies against.
		const signatureOverride = await signWebhook(JSON.stringify({ ref: 'x', repository: { clone_url: cloneUrl } }), 'other-secret')
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, installationId: 42, secret: SECRET, signatureOverride })

		const response = await handleWebhook(request, {
			repositories: db,
			verifier,
			queue,
			connectionId: CONNECTION_ID,
		})
		expect(response.status).toBe(401)
	})

	test('a verified push on an UNSUBSCRIBED ref is a 204 no-op (no run, no enqueue)', async () => {
		const harness = createHarness()
		const { db } = harness
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(harness, cloneUrl) // only refs/heads/deploy/prod is subscribed
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/main', cloneUrl, installationId: 42, secret: SECRET })

		const response = await handleWebhook(request, {
			repositories: db,
			verifier,
			queue,
			connectionId: CONNECTION_ID,
		})

		expect(response.status).toBe(204)
		expect(queue.sent).toHaveLength(0)
		expect(await db.runs.listRuns({ limit: 10 })).toHaveLength(0)
	})

	test('a push for an UNREGISTERED repo is a 204 no-op', async () => {
		const harness = createHarness()
		const { db } = harness
		await seedRegistry(harness, 'https://github.com/acme/app.git')
		const queue = makeQueue()
		const request = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl: 'https://github.com/other/repo.git',
			installationId: 42,
			secret: SECRET,
		})

		const response = await handleWebhook(request, {
			repositories: db,
			verifier,
			queue,
			connectionId: CONNECTION_ID,
		})
		expect(response.status).toBe(204)
		expect(queue.sent).toHaveLength(0)
	})

	test('a v* tag pattern env triggers on a matching tag push; the DEPLOYED ref is the concrete tag', async () => {
		const { db, sqlite } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		insertConnection(sqlite, CONNECTION_ID, 'acme', 42)
		await db.registry.createApp({ id: 'app', repoUrl: normalizeRepoUrl(cloneUrl), githubConnectionId: CONNECTION_ID, githubInstallationId: 42 })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'release', { triggerRef: 'refs/tags/v*' }))
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/tags/v1.2.3', cloneUrl, after: 'sha-tag', installationId: 42, secret: SECRET })

		const response = await handleWebhook(request, {
			repositories: db,
			verifier,
			queue,
			connectionId: CONNECTION_ID,
		})

		expect(response.status).toBe(200)
		const body = (await response.json()) as { triggered: string[] }
		expect(body.triggered).toHaveLength(1)
		const run = await db.runs.getRun(body.triggered[0]!)
		expect(run?.env).toBe('release')
		expect(run?.ref).toBe('refs/tags/v1.2.3') // the concrete pushed ref, not the pattern
		expect(queue.sent).toHaveLength(1)
	})

	test('a tag push NOT matching the v* pattern is a 204 no-op', async () => {
		const { db, sqlite } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		insertConnection(sqlite, CONNECTION_ID, 'acme', 42)
		await db.registry.createApp({ id: 'app', repoUrl: normalizeRepoUrl(cloneUrl), githubConnectionId: CONNECTION_ID, githubInstallationId: 42 })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'release', { triggerRef: 'refs/tags/v*' }))
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/tags/release-1', cloneUrl, installationId: 42, secret: SECRET })

		const response = await handleWebhook(request, {
			repositories: db,
			verifier,
			queue,
			connectionId: CONNECTION_ID,
		})
		expect(response.status).toBe(204)
		expect(queue.sent).toHaveLength(0)
	})

	test('repo URL matching is normalized (registered https vs pushed .git/scp form both match)', async () => {
		const { db, sqlite } = createHarness()
		insertConnection(sqlite, CONNECTION_ID, 'acme', 42)
		// Registered WITHOUT .git; pushed WITH .git and mixed case host — must still match.
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/App', githubConnectionId: CONNECTION_ID, githubInstallationId: 42 })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod', { triggerRef: 'refs/heads/deploy/prod' }))
		const queue = makeQueue()
		const request = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl: 'https://GitHub.com/acme/App.git',
			installationId: 42,
			secret: SECRET,
		})

		const response = await handleWebhook(request, {
			repositories: db,
			verifier,
			queue,
			connectionId: CONNECTION_ID,
		})
		expect(response.status).toBe(200)
		expect(queue.sent).toHaveLength(1)
	})

	test("requires the payload installation id and the connection's installation", async () => {
		const harness = createHarness()
		const { db } = harness
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(harness, cloneUrl)
		const queue = makeQueue()
		const missingInstallation = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, secret: SECRET })
		const swappedInstallation = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, installationId: 43, secret: SECRET })
		const deps: WebhookDeps = {
			repositories: db,
			verifier,
			queue,
			connectionId: CONNECTION_ID,
		}

		expect((await handleWebhook(missingInstallation, deps)).status).toBe(204)
		expect((await handleWebhook(swappedInstallation, deps)).status).toBe(204)
		expect(queue.sent).toHaveLength(0)
	})

	test('a scoped delivery triggers only the exact connection, installation, repository owner, and Zerops environment', async () => {
		const { db, sqlite } = createHarness()
		insertConnection(sqlite, 'connection-a', 'acme', 42)
		insertConnection(sqlite, 'connection-b', 'beta', 43)
		await seedZeropsApp(db, { id: 'app-a', repoUrl: 'github.com/acme/app', connectionId: 'connection-a', installationId: 42 })
		await seedZeropsApp(db, { id: 'app-b', repoUrl: 'github.com/beta/app', connectionId: 'connection-b', installationId: 43 })
		const queue = makeQueue()
		const exact = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl: 'https://github.com/acme/app.git',
			installationId: 42,
			secret: SECRET,
		})
		const swappedInstallation = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl: 'https://github.com/acme/app.git',
			installationId: 43,
			secret: SECRET,
		})
		const swappedRepository = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl: 'https://github.com/beta/app.git',
			installationId: 42,
			secret: SECRET,
		})
		const deps: WebhookDeps = {
			repositories: db,
			verifier,
			queue,
			connectionId: 'connection-a',
		}

		expect((await handleWebhook(exact, deps)).status).toBe(200)
		expect((await handleWebhook(swappedInstallation, deps)).status).toBe(204)
		expect((await handleWebhook(swappedRepository, deps)).status).toBe(204)
		const runs = await db.runs.listRuns({ limit: 10 })
		expect(runs).toHaveLength(1)
		expect(runs[0]?.app_id).toBe('app-a')
		expect(runs[0]?.env).toBe('prod')
		expect(queue.sent).toHaveLength(1)
	})

	test.each(['ping', 'installation', 'pull_request'])('a verified %s delivery is a 204 no-op, never a run', async (event) => {
		const harness = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(harness, cloneUrl)
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, installationId: 42, secret: SECRET, event })

		const response = await handleWebhook(request, { repositories: harness.db, verifier, queue, connectionId: CONNECTION_ID })

		expect(response.status).toBe(204)
		expect(queue.sent).toEqual([])
		expect(await harness.db.runs.listRuns({ limit: 10 })).toEqual([])
	})

	test('an unsigned ping is still refused before its event is read', async () => {
		const harness = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(harness, cloneUrl)
		const request = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl,
			installationId: 42,
			secret: SECRET,
			event: 'ping',
			signatureOverride: await signWebhook('{}', SECRET),
		})

		const response = await handleWebhook(request, { repositories: harness.db, verifier, queue: makeQueue(), connectionId: CONNECTION_ID })

		expect(response.status).toBe(401)
	})

	test.each([
		['deleted: true', { deleted: true, after: '0'.repeat(40) }],
		['an all-zero after', { after: '0'.repeat(40) }],
	])('a ref deletion (%s) on a subscribed ref is a 204 no-op', async (_name, deletion) => {
		const harness = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(harness, cloneUrl)
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, installationId: 42, secret: SECRET, ...deletion })

		const response = await handleWebhook(request, { repositories: harness.db, verifier, queue, connectionId: CONNECTION_ID })

		expect(response.status).toBe(204)
		expect(queue.sent).toEqual([])
		expect(await harness.db.runs.listRuns({ limit: 10 })).toEqual([])
	})

	test('an annotated tag push records the tagged commit, not the tag object `after` names', async () => {
		const { db, sqlite } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		insertConnection(sqlite, CONNECTION_ID, 'acme', 42)
		await db.registry.createApp({ id: 'app', repoUrl: normalizeRepoUrl(cloneUrl), githubConnectionId: CONNECTION_ID, githubInstallationId: 42 })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'release', { triggerRef: 'refs/tags/v*' }))
		const tagObject = 'a'.repeat(40)
		const commit = 'b'.repeat(40)
		const request = await pushWebhookRequest({
			ref: 'refs/tags/v1.2.3',
			cloneUrl,
			after: tagObject,
			headCommitId: commit,
			installationId: 42,
			secret: SECRET,
		})

		const response = await handleWebhook(request, { repositories: db, verifier, queue: makeQueue(), connectionId: CONNECTION_ID })

		expect(response.status).toBe(200)
		const [run] = await db.runs.listRuns({ limit: 10 })
		expect(run?.commit_sha).toBe(commit)
	})

	test('does not misreport a post-verification queue failure as an authentication failure', async () => {
		const harness = createHarness()
		const { db } = harness
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(harness, cloneUrl)
		const request = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl,
			installationId: 42,
			secret: SECRET,
		})

		await expect(handleWebhook(request, {
			repositories: db,
			verifier,
			queue: { send: () => Promise.reject(new Error('queue unavailable')) },
			connectionId: CONNECTION_ID,
		})).rejects.toThrow('queue unavailable')
	})
})
