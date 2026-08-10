import { notesGates } from '@fabrika/example-zerops-app/gates'
import { buildCaddyConfig } from '@fabrika/proxy'
import type { ProxyManifest } from '@fabrika/proxy-contract'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
// A relative import, because the module it names is dev-time only and therefore outside
// `@fabrika/installation-zerops`'s published surface — see its header for why it cannot be exported.
import { platformProxyManifestTemplate, resolvePlatformProxyManifest } from '../../installation-zerops/zerops/proxy-manifest'

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

/**
 * The local platform proxy fronts the same three apps a real installation does, generated from the same
 * declaration — `platformProxyManifestTemplate()` in `@fabrika/installation-zerops` — so this
 * composition can no longer be a second definition of the same document. Only what is genuinely local
 * is supplied here: the hostnames, the scheme, and IAM's port.
 *
 * That is the point of the item this closes (backlog 58): the live installation's manifest was
 * hand-written and gated the whole control plane `public` while `CONTROL_PROXY_GATES` said otherwise,
 * and neither `local:smoke` nor any test could see it, because the two documents had no common source.
 *
 * One proxy in front of three services is the ZEROPS shape; on Cloudflare each service has its own
 * proxy Worker. That is the only structural difference. Both compositions name the Operations host by
 * the same `OPERATIONS_APP_ID`, which they must: a manifest may not name one app twice, so the
 * Cloudflare entry's old `vozka` was the one shape a shared manifest could never express.
 */
export const localPlatformProxyManifest = (): ProxyManifest =>
	resolvePlatformProxyManifest(platformProxyManifestTemplate(), {
		scheme: 'http',
		placement: {
			// IAM listens on the composition's public port here, because its issuer carries that port
			// (`http://iam.fabrika.localhost:18080`); an installation runs it on 3000 like the rest.
			iam: { hosts: ['iam.fabrika.localhost'], upstream: 'iam:18080' },
			control: { hosts: ['control.fabrika.localhost'] },
			operations: { hosts: ['errors.fabrika.localhost'] },
		},
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
	// Plain `bun run`, never wrapped in the developer's core-leasing helper: this also runs where that
	// helper is not on PATH, and wrapping it once failed with `Executable not found in $PATH: "cpu-lease"`.
	//
	// This is reached only from `local:up`, `local:reset` and `browser:up`. It is deliberately NOT a
	// `prepare` script any more — as one it ran inside every `bun install`, spawning this nested build
	// against a `node_modules` the outer install was still writing. See this package's CLAUDE.md.
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
