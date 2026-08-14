import { describe, expect, test } from 'bun:test'
import { FakeRepoSource, normalizeRepoUrl } from '../repo-source'
import type { DeployJobMessage } from '../run-lifecycle'
import { handleWebhook, type WebhookDeps } from '../webhook'
import { createHarness, pushWebhookRequest, signWebhook } from './helpers/harness'
import { providerEnvironment } from './helpers/provider'

// The webhook is the one unauthenticated route, HMAC-gated. These tests exercise: (1) signature
// verification (good/bad), (2) repo+ref → (app, env) mapping driving run creation + enqueue, (3) the
// verified-but-unsubscribed no-op. FakeRepoSource runs the REAL HMAC verify, so the signature path is
// genuine — no GitHub, no Cloudflare.

const SECRET = 'webhook-test-secret'

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
		connection_id, transport_kind, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		credential_sha256, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, 'keyed-v2', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'all', '[]', '[]', 'test', 1, 1, 1)`)
		.run(
			connectionId,
			`${connectionId}-app-id`,
			`${connectionId}-app`,
			`https://github.com/apps/${connectionId}-app`,
			owner,
			`${connectionId}-app`,
			'a'.repeat(64),
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
 * Seed an account + app + app_env with a trigger ref pointing at `prod`. Stores the NORMALIZED repo
 * URL (the handlers normalize on write; here we seed the Db directly, so we normalize explicitly).
 */
async function seedRegistry(db: ReturnType<typeof createHarness>['db'], cloneUrl: string): Promise<void> {
	await db.registry.createApp({ id: 'app', repoUrl: normalizeRepoUrl(cloneUrl), githubInstallationId: 42 })
	await db.registry.upsertAppEnv(providerEnvironment('app', 'prod', { triggerRef: 'refs/heads/deploy/prod' }))
}

describe('handleWebhook (HMAC + ref→env)', () => {
	test('a valid signature on a subscribed ref creates a pending run + enqueues it', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl)
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, after: 'sha-1', installationId: 42, secret: SECRET })

		const response = await handleWebhook(request, {
			repositories: db,
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'installation-only' },
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
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl)
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
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'installation-only' },
		})

		expect(response.status).toBe(401)
		expect(queue.sent).toHaveLength(0)
		expect(await db.runs.listRuns({ limit: 10 })).toHaveLength(0)
	})

	test('a signature for the WRONG secret is rejected (401)', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl)
		const queue = makeQueue()
		// Sign with a different secret than the source verifies against.
		const signatureOverride = await signWebhook(JSON.stringify({ ref: 'x', repository: { clone_url: cloneUrl } }), 'other-secret')
		const request = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, installationId: 42, secret: SECRET, signatureOverride })

		const response = await handleWebhook(request, {
			repositories: db,
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'installation-only' },
		})
		expect(response.status).toBe(401)
	})

	test('a verified push on an UNSUBSCRIBED ref is a 204 no-op (no run, no enqueue)', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl) // only refs/heads/deploy/prod is subscribed
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/heads/main', cloneUrl, installationId: 42, secret: SECRET })

		const response = await handleWebhook(request, {
			repositories: db,
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'installation-only' },
		})

		expect(response.status).toBe(204)
		expect(queue.sent).toHaveLength(0)
		expect(await db.runs.listRuns({ limit: 10 })).toHaveLength(0)
	})

	test('a push for an UNREGISTERED repo is a 204 no-op', async () => {
		const { db } = createHarness()
		await seedRegistry(db, 'https://github.com/acme/app.git')
		const queue = makeQueue()
		const request = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl: 'https://github.com/other/repo.git',
			installationId: 42,
			secret: SECRET,
		})

		const response = await handleWebhook(request, {
			repositories: db,
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'installation-only' },
		})
		expect(response.status).toBe(204)
		expect(queue.sent).toHaveLength(0)
	})

	test('a v* tag pattern env triggers on a matching tag push; the DEPLOYED ref is the concrete tag', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await db.registry.createApp({ id: 'app', repoUrl: normalizeRepoUrl(cloneUrl), githubInstallationId: 42 })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'release', { triggerRef: 'refs/tags/v*' }))
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/tags/v1.2.3', cloneUrl, after: 'sha-tag', installationId: 42, secret: SECRET })

		const response = await handleWebhook(request, {
			repositories: db,
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'installation-only' },
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
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await db.registry.createApp({ id: 'app', repoUrl: normalizeRepoUrl(cloneUrl), githubInstallationId: 42 })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'release', { triggerRef: 'refs/tags/v*' }))
		const queue = makeQueue()
		const request = await pushWebhookRequest({ ref: 'refs/tags/release-1', cloneUrl, installationId: 42, secret: SECRET })

		const response = await handleWebhook(request, {
			repositories: db,
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'installation-only' },
		})
		expect(response.status).toBe(204)
		expect(queue.sent).toHaveLength(0)
	})

	test('repo URL matching is normalized (registered https vs pushed .git/scp form both match)', async () => {
		const { db } = createHarness()
		// Registered WITHOUT .git; pushed WITH .git and mixed case host — must still match.
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/App', githubInstallationId: 42 })
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
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'installation-only' },
		})
		expect(response.status).toBe(200)
		expect(queue.sent).toHaveLength(1)
	})

	test('requires the payload installation id and an exact installation-only app binding', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl)
		const queue = makeQueue()
		const missingInstallation = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, secret: SECRET })
		const swappedInstallation = await pushWebhookRequest({ ref: 'refs/heads/deploy/prod', cloneUrl, installationId: 43, secret: SECRET })
		const deps: WebhookDeps = {
			repositories: db,
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'installation-only' },
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
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue,
			binding: { kind: 'connection', connectionId: 'connection-a' },
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

	test('does not misreport a post-verification queue failure as an authentication failure', async () => {
		const { db } = createHarness()
		const cloneUrl = 'https://github.com/acme/app.git'
		await seedRegistry(db, cloneUrl)
		const request = await pushWebhookRequest({
			ref: 'refs/heads/deploy/prod',
			cloneUrl,
			installationId: 42,
			secret: SECRET,
		})

		await expect(handleWebhook(request, {
			repositories: db,
			repoSource: new FakeRepoSource({ webhookSecret: SECRET }),
			queue: { send: () => Promise.reject(new Error('queue unavailable')) },
			binding: { kind: 'installation-only' },
		})).rejects.toThrow('queue unavailable')
	})
})
