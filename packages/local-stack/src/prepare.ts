import { writeGeneratedEntry } from '@fabrika/app/build'
import {
	appEnvironmentId,
	contractDigest,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_PROXY_SECRET,
	FABRIKA_SERVICE_TABLE_DIGEST,
	proxySecretVariable,
} from '@fabrika/auth-core'
import { PLATFORM_CONSOLE_APP_ID, platformProxyManifestTemplate, resolvePlatformProxyManifest } from '@fabrika/platform-artifacts/proxy-manifest'
import { decodeZeropsNamespaceProxySource, verifyZeropsNamespaceProxySource } from '@fabrika/provider-zerops'
import {
	type McpClient,
	parseMcpClientsJson,
	platformIamOAuthConfig,
	type PlatformProxyComposition,
	type PlatformProxyManifest,
	platformServiceTableDigest,
} from '@fabrika/provider-zerops/installation'
import { buildCaddyConfig } from '@fabrika/proxy'
import { type ContractProxyTable, contractProxyTable, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import { NOTES_APP_ID, notesContract } from 'fabrika-example-zerops/fabrika.config'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCAL_SOURCE_FIXTURE_DIRECTORY, LOCAL_SOURCE_PLATFORM_REPOSITORY } from './local-source-contract'
import { prepareLocalSourceFixtures } from './local-source-fixtures/fixture'
import { applicationFixtureRoot } from './local-source-fixtures/generate'
import { MAIL_DIRECTORY } from './mail-capture'
import { ensureLocalGitHubApps } from './source-connection-fixture'

export const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
export const LOCAL_STACK_DIR = resolve(REPO_ROOT, 'packages', 'local-stack')
export const STATE_DIR = resolve(LOCAL_STACK_DIR, '.state')
export const COMPOSE_FILE = resolve(LOCAL_STACK_DIR, 'compose.yaml')

const LOCAL_PUBLIC_PORT = 18080
const IAM_ISSUER = `http://iam.fabrika.localhost:${LOCAL_PUBLIC_PORT}`
export const LOCAL_OPERATIONS_ORIGIN = `http://errors.fabrika.localhost:${LOCAL_PUBLIC_PORT}`

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

export const writeEnv = async (directory: string, name: string, values: Record<string, string>): Promise<void> => {
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
		'apps-proxy-secret.env',
		'emulator.env',
	]
	const existingFiles = requiredFiles.filter((file) => existsSync(resolve(directory, file)))
	if (existingFiles.length === requiredFiles.length) {
		await ensureObjectStorageSecrets(directory)
		await ensureAppsStorageIdentity(directory)
		await ensureLocalGitHubApps(directory)
		return
	}
	if (existingFiles.length > 0) {
		throw new Error('local credentials are incomplete; restore the missing .state files or explicitly reset the stack')
	}

	const platformDatabasePassword = randomSecret()
	const appsDatabasePassword = randomSecret()
	const appsStorageSecret = randomSecret()
	const notesProxySecret = randomSecret()
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
		// What the platform writes into a contract application on Zerops (ADR-0022 rule 5, F1), for the composed container.
		writeEnv(directory, 'notes.env', {
			FABRIKA_APP_DATABASE_URL: `postgres://postgres:${appsDatabasePassword}@apps-db:5432/notes`,
			FABRIKA_PROXY_SECRET: notesProxySecret,
			FABRIKA_APP_STORAGE_ENDPOINT: 'http://apps-storage:9000',
			FABRIKA_APP_STORAGE_BUCKET: NOTES_BUCKET,
			FABRIKA_APP_STORAGE_ACCESS_KEY_ID: 'notes',
			FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY: appsStorageSecret,
		}),
		// The apps proxy's Caddy sends it as `X-Fabrika-Proxy-Secret`; the auth service only checks that it is set.
		writeEnv(directory, 'apps-proxy-secret.env', {
			[proxySecretVariable(LOCAL_NOTES_IAM_APP_ID)]: notesProxySecret,
		}),
		writeEnv(directory, 'emulator.env', { LOCAL_ZEROPS_TOKEN: emulatorToken }),
	])
	await ensureObjectStorageSecrets(directory)
	await ensureAppsStorageIdentity(directory)
	await ensureLocalGitHubApps(directory)
}

/** The bucket of the Notes example's `attachments` collection, on the apps network's own object storage. */
export const NOTES_BUCKET = 'notes-files'

/** The apps object storage's one identity, from the credentials `notes.env` holds; a stack from before them needs a reset. */
async function ensureAppsStorageIdentity(directory: string): Promise<void> {
	const notes = await readEnv(directory, 'notes.env')
	const accessKey = envValue(notes, 'FABRIKA_APP_STORAGE_ACCESS_KEY_ID')
	const secretKey = envValue(notes, 'FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY')
	if (!accessKey || !secretKey || !envValue(notes, FABRIKA_PROXY_SECRET)) {
		throw new Error('local Notes credentials predate the contract application; explicitly reset the local stack')
	}
	const config = {
		identities: [{
			name: 'notes',
			credentials: [{ accessKey, secretKey }],
			actions: [`Read:${NOTES_BUCKET}`, `Write:${NOTES_BUCKET}`, `List:${NOTES_BUCKET}`],
		}],
	}
	await Bun.write(resolve(directory, 'apps-storage-identities.json'), `${JSON.stringify(config, null, '\t')}\n`)
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
 * hand-written and gated the whole control plane `public` while the console's gates said otherwise,
 * and neither `local:smoke` nor any test could see it, because the two documents had no common source.
 *
 * One proxy in front of three services is the ZEROPS shape; on Cloudflare each service has its own
 * proxy Worker. That is the only structural difference. Both compositions name the Operations host by
 * the same `OPERATIONS_APP_ID`, which they must: a manifest may not name one app twice, so the
 * Cloudflare entry's old `vozka` was the one shape a shared manifest could never express.
 */
const localComposition = (mcpClients: readonly McpClient[] | undefined): PlatformProxyComposition => ({
	scheme: 'http',
	placement: {
		// IAM listens on the composition's public port here, because its issuer carries that port
		// (`http://iam.fabrika.localhost:18080`); an installation runs it on 3000 like the rest.
		iam: { hosts: ['iam.fabrika.localhost'], upstream: 'iam:18080' },
		control: { hosts: ['control.fabrika.localhost'] },
		operations: { hosts: ['errors.fabrika.localhost'] },
	},
	publicPort: LOCAL_PUBLIC_PORT,
	...(mcpClients === undefined ? {} : { authorizationServer: IAM_ISSUER }),
})

export const localPlatformProxyManifest = (mcpClients?: readonly McpClient[]): PlatformProxyManifest =>
	resolvePlatformProxyManifest(platformProxyManifestTemplate(), localComposition(mcpClients))

/**
 * MCP authoring is OFF locally unless `FABRIKA_LOCAL_MCP_CLIENTS_JSON` names clients before `local:up`:
 * a managed client is a CIMD document IAM fetches over HTTPS, and no local one exists. Same JSON shape
 * and parser as an installation's `FABRIKA_PLATFORM_MCP_CLIENTS_JSON`.
 */
export const readLocalMcpClients = (env: Record<string, string | undefined>): readonly McpClient[] | undefined => {
	const raw = env['FABRIKA_LOCAL_MCP_CLIENTS_JSON']
	return raw === undefined || raw.trim() === '' ? undefined : parseMcpClientsJson(raw)
}

/** IAM's `FABRIKA_IAM_OAUTH_CONFIG` for the local composition; empty — OAuth off — without clients. */
export const localIamOAuthConfig = (mcpClients: readonly McpClient[] | undefined): string =>
	mcpClients === undefined ? '' : JSON.stringify(platformIamOAuthConfig(platformProxyManifestTemplate(), localComposition(mcpClients), mcpClients))

/** The local `notes` service plays the `prod` environment; IAM knows it as `notes@prod` (ADR-0022 rule 6). */
export const LOCAL_NOTES_ENVIRONMENT = 'prod'
export const LOCAL_NOTES_IAM_APP_ID = appEnvironmentId(NOTES_APP_ID, LOCAL_NOTES_ENVIRONMENT)

/**
 * The apps proxy fronts the Notes example by its contract's endpoint table, as a namespace proxy fronts a contract
 * application whose snapshot Control approved. `followNotesDeploy` passes the table Control published instead; the
 * placement stays local.
 */
export const localAppsProxyManifest = (table: ContractProxyTable = contractProxyTable(notesContract)): ProxyManifest => ({
	apps: [
		{
			id: LOCAL_NOTES_IAM_APP_ID,
			hosts: ['notes.fabrika.localhost'],
			upstream: 'notes:3000',
			scheme: 'http',
			// The origin of the local ingest DSN; the proxy's CSP lets the browser report to it.
			operationsOrigin: LOCAL_OPERATIONS_ORIGIN,
			...table,
		},
	],
})

/** The digest the composed container starts under; it refuses to start under another contract. */
export const writeNotesContractDigest = (digest: string): Promise<void> =>
	writeEnv(STATE_DIR, 'notes-contract.env', { [FABRIKA_CONTRACT_DIGEST]: digest })

/**
 * Rewritten on every prepare, so a contract edit reaches the composed container: its digest (the container refuses to
 * start under another), the entrypoint the platform build writes and the SPA its `site` mount serves.
 */
const prepareNotesApplication = async (): Promise<void> => {
	await writeNotesContractDigest(contractDigest(notesContract))
	await writeGeneratedEntry(applicationFixtureRoot, 'bun')
	await buildNotesSpa(applicationFixtureRoot)
}

/**
 * Builds the SPA of a Notes source the composed container serves (`dist/web`), with that source's own build script,
 * as its platform build does: the workspace example on every prepare, a followed fixture commit before it is served.
 */
export const buildNotesSpa = async (root: string): Promise<void> => {
	const build = Bun.spawn(['bun', 'build-web.ts'], { cwd: root, stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' })
	const [exitCode, errors] = await Promise.all([build.exited, new Response(build.stderr).text()])
	if (exitCode !== 0) {
		throw new Error(`the Notes SPA in ${root} did not build:\n${errors}`)
	}
}

/** The apps proxy's manifest and its Caddy configuration; the containers read them when they start. */
export const writeAppsProxyConfig = async (appsManifest: ProxyManifest): Promise<void> => {
	await Promise.all([
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

const generateProxyConfigs = async (mcpClients: readonly McpClient[] | undefined): Promise<void> => {
	const platformManifest = localPlatformProxyManifest(mcpClients)
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
		writeAppsProxyConfig(localAppsProxyManifest()),
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
	// Made here, by the host's user, so a reset can remove the messages the IAM container writes as root.
	mkdirSync(MAIL_DIRECTORY, { recursive: true, mode: 0o700 })
	// Plain `bun run`, never wrapped in the developer's core-leasing helper: this also runs where that
	// helper is not on PATH, and wrapping it once failed with `Executable not found in $PATH: "cpu-lease"`.
	//
	// This is reached only from `local:up`, `local:reset` and `browser:up`. It is deliberately NOT a
	// `prepare` script any more — as one it ran inside every `bun install`, spawning this nested build
	// against a `node_modules` the outer install was still writing. See this package's CLAUDE.md.
	await run(['bun', 'run', '--filter', '@fabrika/dashboard', 'build'])
	await prepareLocalSecrets()
	await prepareLocalSourceConfiguration()
	const mcpClients = readLocalMcpClients(process.env)
	// Rewritten on every prepare, so turning MCP off is unsetting the variable and running `local:up`.
	await writeEnv(STATE_DIR, 'iam-oauth.env', { FABRIKA_IAM_OAUTH_CONFIG: localIamOAuthConfig(mcpClients) })
	await writeEnv(STATE_DIR, 'control-table.env', {
		[FABRIKA_SERVICE_TABLE_DIGEST]: platformServiceTableDigest(localPlatformProxyManifest(mcpClients), PLATFORM_CONSOLE_APP_ID),
	})
	await generateProxyConfigs(mcpClients)
	await prepareNotesApplication()
	console.info(`Local stack prepared for ${IAM_ISSUER}; MCP authoring ${mcpClients === undefined ? 'off' : 'on'}`)
}

if (import.meta.main) {
	prepareLocalStack().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'local stack preparation failed')
		process.exit(1)
	})
}
