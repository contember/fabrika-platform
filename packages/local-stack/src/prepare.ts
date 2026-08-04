import { notesGates } from '@fabrika/example-zerops-app/gates'
import { OPERATIONS_RELEASE_RECONCILE_PATH, OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'
import { buildCaddyConfig } from '@fabrika/proxy'
import type { ProxyApp, ProxyManifest } from '@fabrika/proxy-contract'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
export const LOCAL_STACK_DIR = resolve(REPO_ROOT, 'packages', 'local-stack')
export const STATE_DIR = resolve(LOCAL_STACK_DIR, '.state')
export const COMPOSE_FILE = resolve(LOCAL_STACK_DIR, 'compose.yaml')

const IAM_ISSUER = 'http://iam.fabrika.localhost:18080'

const statePath = (name: string): string => resolve(STATE_DIR, name)

/**
 * A 256-bit secret in base64url, never starting with `-` or `_`.
 *
 * base64url may begin with either, and a credential that begins with `-` reads as a FLAG to anything
 * that takes it on a command line no matter how it is quoted: a rolled MinIO password beginning with
 * `-` made `mc alias set` print its usage and loop forever, and the whole composition came up without
 * an object store. Rerolling costs nothing and removes a bug that only appears about one reset in
 * sixteen.
 */
const randomSecret = (): string => {
	for (;;) {
		const value = randomBytes(32).toString('base64url')
		if (!value.startsWith('-') && !value.startsWith('_')) {
			return value
		}
	}
}

const randomBase64Key = (): string => randomBytes(32).toString('base64')

const writeEnv = async (name: string, values: Record<string, string>): Promise<void> => {
	const lines = Object.entries(values).map(([key, value]) => {
		if (value.includes('\n') || value.includes('\r')) {
			throw new Error(`${key} cannot contain a newline`)
		}
		return `${key}=${value}`
	})
	await Bun.write(statePath(name), `${lines.join('\n')}\n`)
}

const writeJson = (name: string, value: unknown): Promise<number> => Bun.write(statePath(name), `${JSON.stringify(value, null, '\t')}\n`)

const generateSecrets = async (): Promise<void> => {
	const requiredFiles = [
		'platform-db.env',
		'apps-db.env',
		'minio.env',
		'iam.env',
		'control.env',
		'operations.env',
		'platform-proxy.env',
		'apps-proxy.env',
		'notes.env',
		'emulator.env',
	]
	if (requiredFiles.every((file) => existsSync(statePath(file)))) {
		return
	}

	const platformDatabasePassword = randomSecret()
	const appsDatabasePassword = randomSecret()
	const minioPassword = randomSecret()
	const rpcKey = `px_${randomSecret()}`
	const proxyKey = `px_${randomSecret()}`
	const provisioningKey = `px_${randomSecret()}`
	const operationsSyncKey = randomSecret()
	const githubWebhookSecret = randomSecret()
	const emulatorToken = randomSecret()
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
	const signingKeys = JSON.stringify([privateKey.export({ format: 'jwk' })])

	await Promise.all([
		writeEnv('platform-db.env', { POSTGRES_PASSWORD: platformDatabasePassword }),
		writeEnv('apps-db.env', { POSTGRES_DB: 'notes', POSTGRES_PASSWORD: appsDatabasePassword }),
		writeEnv('minio.env', { MINIO_ROOT_USER: 'fabrika-local', MINIO_ROOT_PASSWORD: minioPassword }),
		writeEnv('iam.env', {
			FABRIKA_IAM_DATABASE_URL: `postgres://postgres:${platformDatabasePassword}@platform-db:5432/iam`,
			FABRIKA_IAM_SIGNING_KEYS: signingKeys,
			FABRIKA_IAM_RPC_KEY: rpcKey,
			FABRIKA_IAM_PROXY_KEY: proxyKey,
			FABRIKA_IAM_PROVISIONING_KEY: provisioningKey,
		}),
		writeEnv('operations.env', {
			FABRIKA_OPERATIONS_DATABASE_URL: `postgres://postgres:${platformDatabasePassword}@platform-db:5432/operations`,
			FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID: 'fabrika-local',
			FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY: minioPassword,
			OPERATIONS_SYNC_KEY: operationsSyncKey,
			FABRIKA_IAM_RPC_KEY: rpcKey,
		}),
		writeEnv('control.env', {
			FABRIKA_CONTROL_DATABASE_URL: `postgres://postgres:${platformDatabasePassword}@platform-db:5432/control`,
			FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'fabrika-local',
			FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: minioPassword,
			FABRIKA_IAM_RPC_KEY: rpcKey,
			FABRIKA_IAM_PROVISIONING_KEY: provisioningKey,
			OPERATIONS_SYNC_KEY: operationsSyncKey,
			GITHUB_WEBHOOK_SECRET: githubWebhookSecret,
			FABRIKA_CONTROL_VAULT_KEY: randomBase64Key(),
			FABRIKA_ZEROPS_ACCESS_TOKEN: emulatorToken,
			FABRIKA_ZEROPS_PROXY_IAM_KEY: proxyKey,
		}),
		writeEnv('platform-proxy.env', { FABRIKA_IAM_KEY: proxyKey }),
		writeEnv('apps-proxy.env', { FABRIKA_IAM_KEY: proxyKey }),
		writeEnv('notes.env', {
			NOTES_DATABASE_URL: `postgres://postgres:${appsDatabasePassword}@apps-db:5432/notes`,
		}),
		writeEnv('emulator.env', { LOCAL_ZEROPS_TOKEN: emulatorToken }),
	])
}

type Gates = ProxyApp['gates']

/**
 * The gates the LOCAL platform proxy enforces.
 *
 * They are copies of the production sets — `CONTROL_PROXY_GATES` in `packages/control/fabrika.config.ts`
 * and `OPERATIONS_PROXY_GATES` in `packages/operations/fabrika.config.ts` — because neither is
 * importable from here: both live in a `fabrika.config.ts` that imports `@fabrika/provider-cloudflare`,
 * and pulling oblaka's raw TypeScript into this package's strict program does not compile. Copies drift,
 * so `__tests__/proxy-gates.test.ts` builds the real Cloudflare proxy Workers and fails if these stop
 * being equal to the manifests those Workers bake in.
 *
 * The local stack is one proxy in front of three services, which is the Zerops platform shape; on
 * Cloudflare each service has its own proxy Worker. That is the only structural difference, and it is
 * why the Operations entry keeps its own app id here (a manifest may not name one app twice) where the
 * Cloudflare Operations proxy reuses `vozka`.
 */
const CONTROL_GATES: Gates = {
	rules: [
		{ path: '/api/*', kind: 'service' },
		{ path: '/api/*', kind: 'human' },
	],
}

const CONTROL_PROXY_GATES: Gates = {
	rules: [
		{ path: '/healthz', kind: 'public' },
		{ path: '/api/health', kind: 'public' },
		{ path: '/webhooks/github', kind: 'public' },
		{ path: '/iam/admin', kind: 'service' },
		{ path: '/iam/admin', kind: 'human' },
		{ path: '/iam/admin/*', kind: 'service' },
		{ path: '/iam/admin/*', kind: 'human' },
		{ path: '/operations/api', kind: 'service' },
		{ path: '/operations/api', kind: 'human' },
		{ path: '/operations/api/*', kind: 'service' },
		{ path: '/operations/api/*', kind: 'human' },
		...CONTROL_GATES.rules,
		{ path: '/*', kind: 'human' },
	],
}

const OPERATIONS_PROXY_GATES: Gates = {
	rules: [
		{ path: '/healthz', kind: 'public' },
		{ path: '/api/*/envelope/', kind: 'public' },
		{ path: OPERATIONS_SOURCE_MAP_UPLOAD_PATH, kind: 'public' },
		{ path: '/private/catalog/reconcile', kind: 'service' },
		{ path: OPERATIONS_RELEASE_RECONCILE_PATH, kind: 'service' },
		{ path: '/api/*', kind: 'service' },
		{ path: '/api/*', kind: 'human' },
	],
}

/** The production gate sets this manifest reproduces, exported for the drift test. */
export const localProductionGates = { vozka: CONTROL_PROXY_GATES, operations: OPERATIONS_PROXY_GATES }

export const localPlatformProxyManifest = (): ProxyManifest => ({
	apps: [
		{
			id: 'iam-local',
			hosts: ['iam.fabrika.localhost'],
			upstream: 'iam:18080',
			// IAM authenticates itself: its login, JWKS and admin surfaces own their own authorization,
			// and a gate in front of the login page is a login loop. This is the production shape too.
			gates: { rules: [{ path: '/*', kind: 'public' }] },
			scheme: 'http',
		},
		{
			id: 'vozka',
			hosts: ['control.fabrika.localhost'],
			upstream: 'control:3000',
			gates: CONTROL_PROXY_GATES,
			scheme: 'http',
		},
		{
			id: 'operations',
			hosts: ['errors.fabrika.localhost'],
			upstream: 'operations:3000',
			scheme: 'http',
			gates: OPERATIONS_PROXY_GATES,
		},
	],
})

const generateProxyConfigs = async (): Promise<void> => {
	const platformManifest = localPlatformProxyManifest()
	const appsManifest: ProxyManifest = {
		apps: [{
			id: 'notes',
			hosts: ['notes.fabrika.localhost'],
			upstream: 'notes:3000',
			gates: notesGates,
			scheme: 'http',
		}],
	}
	await Promise.all([
		writeJson('platform-proxy.manifest.json', platformManifest),
		writeJson(
			'platform-caddy.json',
			buildCaddyConfig(platformManifest, {
				authUpstream: '127.0.0.1:9000',
				listen: [':18080'],
				healthListen: [':19080'],
			}),
		),
		writeJson('apps-proxy.manifest.json', appsManifest),
		writeJson(
			'apps-caddy.json',
			buildCaddyConfig(appsManifest, {
				authUpstream: '127.0.0.1:9000',
				listen: [':18081'],
				healthListen: [':19081'],
			}),
		),
	])
}

const run = async (command: string[]): Promise<void> => {
	const process = Bun.spawn(command, { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
	const exitCode = await process.exited
	if (exitCode !== 0) {
		throw new Error(`${command[0] ?? 'command'} failed with exit code ${exitCode}`)
	}
}

export const prepareLocalStack = async (): Promise<void> => {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
	// Plain `bun run`. This is a `prepare` script, so it executes on every `bun install` of the
	// workspace — including inside CI and inside a Zerops build container, neither of which has a
	// developer's local core-leasing wrapper on PATH. Wrapping it made `bun install --frozen-lockfile`
	// exit 1 with `Executable not found in $PATH: "cpu-lease"` and took every platform build down with it.
	await run(['bun', 'run', '--filter', '@fabrika/dashboard', 'build'])
	await generateSecrets()
	await generateProxyConfigs()
	console.info(`Local stack prepared for ${IAM_ISSUER}`)
}

if (import.meta.main) {
	prepareLocalStack().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'local stack preparation failed')
		process.exit(1)
	})
}
