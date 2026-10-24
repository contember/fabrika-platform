import { PostgresDatabase } from '@fabrika/platform-node'
import type { ProviderEnvironment } from '@fabrika/provider-contract'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	type ZeropsAppConfig,
	zeropsArtifactCodec,
	zeropsNamespaceTargetCodec,
	zeropsStoredTargetCodec,
} from '@fabrika/provider-zerops'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { controlServiceDigest } from '../../../../fabrika.service'
import { hasPostgres, postgresUrl, skipReason } from '../../../__tests__/helpers/postgres'
import { applyMigrations } from '../../../bun/migrate'
import { Vault } from '../../../vault'
import { zeropsGitHubSources } from '../../../zerops/provider'
import { createRuntime } from '../../../zerops/runtime'
import { encodeGitHubAppCredential } from '../../connections/credentials'
import { githubAppCredentialSecretLabel, githubWebhookSecretLabel } from '../../connections/secrets'
import { file, handPrefix, handTarball } from './fixtures'

const COMMIT_SHA = 'a'.repeat(40)
const DESCRIPTOR = 'zerops:\n  - setup: notes\n'
const REPOSITORY = { owner: 'acme', name: 'notes' }
const BINDING = { connectionId: 'acme-connection', installationId: 77 }
const INSTALLATION_TOKEN = 'ghs_fixed_origin_token'
const config: ZeropsAppConfig = { id: 'notes', target: { platform: 'zerops', services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }] } }
const proxySource = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: COMMIT_SHA,
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
}
const descriptor = await createZeropsArtifactSourceDescriptor(DESCRIPTOR)

/** Names an operator might reach for to move GitHub. None of them may reach the source: only code-level seams can (ADR-0029). */
const ORIGIN_OVERRIDES = {
	GITHUB_API_URL: 'https://github.attacker.test',
	GITHUB_API_ORIGIN: 'https://github.attacker.test',
	GITHUB_CODELOAD_URL: 'https://codeload.attacker.test',
	FABRIKA_GITHUB_API_URL: 'https://github.attacker.test',
	FABRIKA_GITHUB_API_ORIGIN: 'https://github.attacker.test',
	FABRIKA_GITHUB_CODELOAD_ORIGIN: 'https://codeload.attacker.test',
	FABRIKA_SOURCE_GITHUB_ORIGIN: 'https://github.attacker.test',
}

const runtimeEnvironment = (databaseUrl: string, vaultKey?: string): Record<string, string> => ({
	...ORIGIN_OVERRIDES,
	FABRIKA_CONTROL_DATABASE_URL: databaseUrl,
	FABRIKA_SERVICE_TABLE_DIGEST: controlServiceDigest({ mcp: false }),
	...(vaultKey === undefined ? {} : { FABRIKA_CONTROL_VAULT_KEY: vaultKey }),
	FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
	FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
	FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
	FABRIKA_IAM_RPC_URL: 'http://iam:3000',
	FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
	FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
	FABRIKA_ZEROPS_CLIENT_ID: 'client-1',
	FABRIKA_ZEROPS_PROXY_SOURCE_JSON: JSON.stringify(proxySource),
	FABRIKA_ZEROPS_PROXY_IAM_URL: 'https://iam.example.test',
	FABRIKA_ZEROPS_PROXY_IAM_KEY: 'px_proxy_placeholder',
	ENVIRONMENT: 'stage',
})

const notesEnvironment = (): ProviderEnvironment => ({
	appId: 'notes',
	env: 'prod',
	namespace: {
		id: 'apps-prod',
		env: 'prod',
		target: {
			provider: 'zerops',
			version: zeropsNamespaceTargetCodec.version,
			payload: zeropsNamespaceTargetCodec.encode({ proxySource, projectId: 'project-1', proxyServiceId: 'proxy-1', ready: true }),
		},
	},
	target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: zeropsStoredTargetCodec.encode({ serviceId: 'notes-1' }) },
	artifact: {
		provider: 'zerops',
		version: zeropsArtifactCodec.version,
		payload: zeropsArtifactCodec.encode(compileFabrikaManifest(config, 'prod', descriptor)),
	},
})

const notesApp = { id: 'notes', source: { repoUrl: `https://github.com/${REPOSITORY.owner}/${REPOSITORY.name}`, ref: 'refs/heads/main' } }

interface RecordedRequest {
	readonly url: string
	readonly authorization: string | null
}

/** The archive of `refs/heads/main`: the commit and its registered descriptor. */
const MAIN_ARCHIVE = Bun.gzipSync(handTarball([file(`${handPrefix}zerops.yaml`, DESCRIPTOR)], { commitSha: COMMIT_SHA }))
const MAIN_CODELOAD = `https://codeload.github.com/${REPOSITORY.owner}/${REPOSITORY.name}/legacy.tar.gz/refs/heads/main?token=grant`

/**
 * Stands in for the network behind the global `fetch` — the transport production uses — and plays GitHub at
 * GitHub's origins only. `tarballLocation` is where the tarball API redirects for the exact commit; the archive of
 * `refs/heads/main` is served.
 */
function githubNetwork(
	tarballLocation = `https://codeload.github.com/${REPOSITORY.owner}/${REPOSITORY.name}/legacy.tar.gz/${COMMIT_SHA}?token=grant`,
) {
	const requested: RecordedRequest[] = []
	const api = `https://api.github.com/repos/${REPOSITORY.owner}/${REPOSITORY.name}`
	const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init)
		const authorization = request.headers.get('authorization')
		requested.push({ url: request.url, authorization })
		const keyed = authorization === `Bearer ${INSTALLATION_TOKEN}`
		if (request.method === 'POST' && request.url === `https://api.github.com/app/installations/${BINDING.installationId}/access_tokens`) {
			return Response.json({ token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 })
		}
		if (keyed && request.url === `${api}/tarball/${encodeURIComponent('refs/heads/main')}`) {
			return new Response(null, { status: 302, headers: { location: MAIN_CODELOAD } })
		}
		if (authorization === null && request.url === MAIN_CODELOAD) return new Response(MAIN_ARCHIVE)
		if (keyed && request.url === `${api}/tarball/${COMMIT_SHA}`) return new Response(null, { status: 302, headers: { location: tarballLocation } })
		return new Response(null, { status: 404 })
	}
	const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(answer, { preconnect: fetch.preconnect }))
	return { requested, restore: () => transport.mockRestore() }
}

const origins = (requested: readonly RecordedRequest[]): string[] => [...new Set(requested.map((request) => new URL(request.url).origin))]

test("the Zerops composition's anonymous resolve addresses api.github.com whatever the environment names", async () => {
	const network = githubNetwork()
	const runtime = createRuntime(runtimeEnvironment('postgres://user:password@127.0.0.1:1/fabrika'))
	try {
		const resolveSource = runtime.provider.resolveSource
		if (resolveSource === undefined) throw new Error('the Zerops provider resolves no source')
		await expect(resolveSource({ runId: 'run-1', app: notesApp, environment: notesEnvironment(), signal: AbortSignal.timeout(5_000) }))
			.rejects.toThrow('(ref_not_found)')
		expect(network.requested.map((request) => request.url)).toEqual([
			`https://api.github.com/repos/acme/notes/tarball/${encodeURIComponent('refs/heads/main')}`,
		])
	} finally {
		network.restore()
		await runtime.shutdown()
	}
})

if (!hasPostgres) console.info(`fixed GitHub origins on the keyed path ${skipReason}`)

describe.skipIf(!hasPostgres)('the keyed path of the Zerops composition', () => {
	const vaultKey = randomBytes(32).toString('base64')
	let databaseUrl = ''
	let dropDatabase = async (): Promise<void> => {}

	beforeAll(async () => {
		if (postgresUrl === null) return
		const name = `control_fixed_origins_${randomBytes(4).toString('hex')}`
		const admin = PostgresDatabase.connect(postgresUrl, { max: 1 })
		await admin.prepare(`CREATE DATABASE ${name}`).run()
		await admin.close()
		const base = postgresUrl
		dropDatabase = async () => {
			const cleanup = PostgresDatabase.connect(base, { max: 1 })
			await cleanup.prepare(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).run()
			await cleanup.close()
		}
		const url = new URL(postgresUrl)
		url.pathname = `/${name}`
		databaseUrl = url.href
		const db = PostgresDatabase.connect(databaseUrl, { max: 1 })
		try {
			await applyMigrations(db)
			const vault = await Vault.create(db, vaultKey)
			const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
			const credentialRef = await vault.putSecret(
				'platform',
				githubAppCredentialSecretLabel(BINDING.connectionId),
				encodeGitHubAppCredential({ appId: '4242', privateKeyPem: privateKey }),
			)
			const webhookRef = await vault.putSecret('platform', githubWebhookSecretLabel(BINDING.connectionId), 'webhook-secret')
			await db.prepare(`INSERT INTO github_source_connections_keyed (
				connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
				app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
				installation_account_login, installation_selection, verified_repositories_json,
				requested_repositories_json, connected_by, connected_at, verified_at, version
			) VALUES (?, '4242', 'acme-app', 'https://github.com/apps/acme-app', ?, 'acme-app', 0, ?, 'https://control.example.test/webhooks/github/acme-connection', ?, ?, ?, 'all', '[]', '[]', 'test', 1, 1, 1)`)
				.bind(BINDING.connectionId, REPOSITORY.owner, credentialRef, webhookRef, BINDING.installationId, REPOSITORY.owner)
				.run()
		} finally {
			await db.close()
		}
	}, 60_000)

	afterAll(async () => {
		await dropDatabase()
	})

	test('mints the installation token and resolves the private repository at api.github.com only', async () => {
		const network = githubNetwork()
		const runtime = createRuntime(runtimeEnvironment(databaseUrl, vaultKey))
		try {
			const resolveSource = runtime.provider.resolveSource
			if (resolveSource === undefined) throw new Error('the Zerops provider resolves no source')
			expect(
				await resolveSource({
					runId: 'run-1',
					app: notesApp,
					environment: notesEnvironment(),
					sourceBinding: BINDING,
					signal: AbortSignal.timeout(10_000),
				}),
			).toEqual({ commitSha: COMMIT_SHA })
			expect(network.requested).toEqual([
				{ url: `https://api.github.com/app/installations/${BINDING.installationId}/access_tokens`, authorization: expect.stringMatching(/^Bearer /) },
				{
					url: `https://api.github.com/repos/acme/notes/tarball/${encodeURIComponent('refs/heads/main')}`,
					authorization: `Bearer ${INSTALLATION_TOKEN}`,
				},
				{ url: MAIN_CODELOAD, authorization: null },
			])
		} finally {
			network.restore()
			await runtime.shutdown()
		}
	})

	const upload = (runtime: ReturnType<typeof createRuntime>) =>
		zeropsGitHubSources(runtime.env).port.upload({
			repository: REPOSITORY,
			commitSha: COMMIT_SHA,
			descriptorSha256: descriptor.sha256,
			archive: { kind: 'application', privateBinding: BINDING },
			uploadUrl: 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?appVersionId=v1',
			signal: AbortSignal.timeout(10_000),
		})

	test('downloads the private archive from codeload.github.com without the installation token', async () => {
		const network = githubNetwork()
		const runtime = createRuntime(runtimeEnvironment(databaseUrl, vaultKey))
		try {
			// Codeload answers 404 here, so the upload stops before any byte would reach Zerops.
			await expect(upload(runtime)).rejects.toThrow('(ref_not_found)')
			expect(origins(network.requested)).toEqual(['https://api.github.com', 'https://codeload.github.com'])
			const codeload = network.requested.filter((request) => new URL(request.url).origin === 'https://codeload.github.com')
			expect(codeload).toEqual([{ url: `https://codeload.github.com/acme/notes/legacy.tar.gz/${COMMIT_SHA}?token=grant`, authorization: null }])
		} finally {
			network.restore()
			await runtime.shutdown()
		}
	})

	test('refuses a tarball redirect to any other origin before requesting it', async () => {
		const network = githubNetwork(`https://codeload.attacker.test/acme/notes/legacy.tar.gz/${COMMIT_SHA}`)
		const runtime = createRuntime(runtimeEnvironment(databaseUrl, vaultKey))
		try {
			await expect(upload(runtime)).rejects.toThrow('(archive_rejected)')
			expect(origins(network.requested)).toEqual(['https://api.github.com'])
		} finally {
			network.restore()
			await runtime.shutdown()
		}
	})
})
