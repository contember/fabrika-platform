import { notesGates } from '@fabrika/example-zerops-app/gates'
import { platformProxyManifestTemplate, resolvePlatformProxyManifest } from '@fabrika/platform-artifacts/proxy-manifest'
import { decodeZeropsNamespaceProxySource, verifyZeropsNamespaceProxySource } from '@fabrika/provider-zerops'
import { buildCaddyConfig } from '@fabrika/proxy'
import type { ProxyManifest } from '@fabrika/proxy-core/manifest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCAL_SOURCE_FIXTURE_DIRECTORY, LOCAL_SOURCE_PLATFORM_REPOSITORY } from './local-source-contract'
import { prepareLocalSourceFixtures } from './local-source-fixtures/fixture'

export const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
export const LOCAL_STACK_DIR = resolve(REPO_ROOT, 'packages', 'local-stack')
export const STATE_DIR = resolve(LOCAL_STACK_DIR, '.state')
export const COMPOSE_FILE = resolve(LOCAL_STACK_DIR, 'compose.yaml')

const IAM_ISSUER = 'http://iam.fabrika.localhost:18080'

const statePath = (name: string): string => resolve(STATE_DIR, name)

// Avoid leading flag characters in credentials that may be passed to a CLI.
const randomSecret = (): string => {
	for (;;) {
		const value = randomBytes(32).toString('base64url')
		if (!value.startsWith('-') && !value.startsWith('_')) {
			return value
		}
	}
}

const randomBase64Key = (): string => randomBytes(32).toString('base64')

const writeEnv = async (directory: string, name: string, values: Record<string, string>): Promise<void> => {
	const lines = Object.entries(values).map(([key, value]) => {
		if (value.includes('\n') || value.includes('\r')) {
			throw new Error(`${key} cannot contain a newline`)
		}
		return `${key}=${value}`
	})
	await Bun.write(resolve(directory, name), `${lines.join('\n')}\n`)
}

const readEnv = async (directory: string, name: string): Promise<Record<string, string>> => {
	const values: Record<string, string> = {}
	for (const line of (await Bun.file(resolve(directory, name)).text()).split('\n')) {
		if (line === '') continue
		const separator = line.indexOf('=')
		if (separator <= 0) throw new Error(`${name} contains an invalid environment entry`)
		const key = line.slice(0, separator)
		if (values[key] !== undefined) throw new Error(`${name} contains a duplicate environment entry`)
		values[key] = line.slice(separator + 1)
	}
	return values
}

const writeJson = (name: string, value: unknown): Promise<number> => Bun.write(statePath(name), `${JSON.stringify(value, null, '\t')}\n`)

export const prepareLocalSecrets = async (directory: string = STATE_DIR): Promise<void> => {
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const requiredFiles = [
		'platform-db.env',
		'apps-db.env',
		'iam.env',
		'control.env',
		'operations.env',
		'platform-proxy.env',
		'apps-proxy.env',
		'notes.env',
		'emulator.env',
	]
	const existingFiles = requiredFiles.filter((file) => existsSync(resolve(directory, file)))
	if (existingFiles.length === requiredFiles.length) {
		await ensureObjectStorageSecrets(directory)
		return
	}
	if (existingFiles.length > 0) {
		throw new Error('local credentials are incomplete; restore the missing .state files or explicitly reset the stack')
	}

	const platformDatabasePassword = randomSecret()
	const appsDatabasePassword = randomSecret()
	const storagePassword = randomSecret()
	const rpcKey = `px_${randomSecret()}`
	const proxyKey = `px_${randomSecret()}`
	const provisioningKey = `px_${randomSecret()}`
	const operationsSyncKey = randomSecret()
	const githubWebhookSecret = randomSecret()
	const emulatorToken = randomSecret()
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
	const signingKeys = JSON.stringify([privateKey.export({ format: 'jwk' })])

	await Promise.all([
		writeEnv(directory, 'platform-db.env', { POSTGRES_PASSWORD: platformDatabasePassword }),
		writeEnv(directory, 'apps-db.env', { POSTGRES_DB: 'notes', POSTGRES_PASSWORD: appsDatabasePassword }),
		writeEnv(directory, 'iam.env', {
			FABRIKA_IAM_DATABASE_URL: `postgres://postgres:${platformDatabasePassword}@platform-db:5432/iam`,
			FABRIKA_IAM_SIGNING_KEYS: signingKeys,
			FABRIKA_IAM_RPC_KEY: rpcKey,
			FABRIKA_IAM_PROXY_KEY: proxyKey,
			FABRIKA_IAM_PROVISIONING_KEY: provisioningKey,
		}),
		writeEnv(directory, 'operations.env', {
			FABRIKA_OPERATIONS_DATABASE_URL: `postgres://postgres:${platformDatabasePassword}@platform-db:5432/operations`,
			FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID: 'fabrika-local',
			FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY: storagePassword,
			OPERATIONS_SYNC_KEY: operationsSyncKey,
			FABRIKA_IAM_RPC_KEY: rpcKey,
		}),
		writeEnv(directory, 'control.env', {
			FABRIKA_CONTROL_DATABASE_URL: `postgres://postgres:${platformDatabasePassword}@platform-db:5432/control`,
			FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'fabrika-local',
			FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: storagePassword,
			FABRIKA_IAM_RPC_KEY: rpcKey,
			FABRIKA_IAM_PROVISIONING_KEY: provisioningKey,
			OPERATIONS_SYNC_KEY: operationsSyncKey,
			GITHUB_WEBHOOK_SECRET: githubWebhookSecret,
			FABRIKA_CONTROL_VAULT_KEY: randomBase64Key(),
			FABRIKA_ZEROPS_ACCESS_TOKEN: emulatorToken,
			FABRIKA_ZEROPS_PROXY_IAM_KEY: proxyKey,
		}),
		writeEnv(directory, 'platform-proxy.env', { FABRIKA_IAM_KEY: proxyKey }),
		writeEnv(directory, 'apps-proxy.env', { FABRIKA_IAM_KEY: proxyKey }),
		writeEnv(directory, 'notes.env', {
			NOTES_DATABASE_URL: `postgres://postgres:${appsDatabasePassword}@apps-db:5432/notes`,
		}),
		writeEnv(directory, 'emulator.env', { LOCAL_ZEROPS_TOKEN: emulatorToken }),
	])
	await ensureObjectStorageSecrets(directory)
}

async function ensureObjectStorageSecrets(directory: string): Promise<void> {
	const control = await readEnv(directory, 'control.env')
	const operations = await readEnv(directory, 'operations.env')
	const accessKey = envValue(control, 'FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID')
	const secretKey = envValue(control, 'FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY')
	if (
		!accessKey || !secretKey
		|| accessKey !== envValue(operations, 'FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID')
		|| secretKey !== envValue(operations, 'FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY')
	) {
		throw new Error('local control and Operations storage credentials must be present and match')
	}
	const config = {
		identities: [{
			name: 'fabrika-local',
			credentials: [{ accessKey, secretKey }],
			actions: ['Read:run-logs', 'Write:run-logs', 'List:run-logs', 'Read:operations-payloads', 'Write:operations-payloads', 'List:operations-payloads'],
		}],
	}
	await Bun.write(resolve(directory, 'object-storage-identities.json'), `${JSON.stringify(config, null, '\t')}\n`)
}

function envValue(values: Record<string, string>, key: string): string | undefined {
	return values[key]
}

export async function prepareLocalSourceConfiguration(directory: string = STATE_DIR): Promise<void> {
	const fixtures = await prepareLocalSourceFixtures(resolve(directory, LOCAL_SOURCE_FIXTURE_DIRECTORY))
	const source = decodeZeropsNamespaceProxySource({
		repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
		commitSha: fixtures.platform.commitSha,
		descriptor: {
			path: 'zerops.yaml',
			contents: fixtures.platform.descriptorContents,
			sha256: fixtures.platform.descriptorSha256,
		},
	})
	await verifyZeropsNamespaceProxySource(source)
	const serialized = JSON.stringify(source)
	const control = await readEnv(directory, 'control.env')
	const existing = control['FABRIKA_ZEROPS_PROXY_SOURCE_JSON']
	if (existing !== undefined && existing !== serialized) {
		throw new Error('local proxy source pin differs from the fixture; explicitly reset the local stack')
	}
	if (existing === undefined) await writeEnv(directory, 'control.env', { ...control, FABRIKA_ZEROPS_PROXY_SOURCE_JSON: serialized })
}

/**
 * The local platform proxy fronts the same three apps a real installation does, generated from the same
 * declaration — `platformProxyManifestTemplate()` in `@fabrika/platform-artifacts` — so this
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
				iamSessionOwner: { issuer: IAM_ISSUER, upstream: 'iam:18080' },
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
	await prepareLocalSecrets()
	await prepareLocalSourceConfiguration()
	await generateProxyConfigs()
	console.info(`Local stack prepared for ${IAM_ISSUER}`)
}

if (import.meta.main) {
	prepareLocalStack().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'local stack preparation failed')
		process.exit(1)
	})
}
