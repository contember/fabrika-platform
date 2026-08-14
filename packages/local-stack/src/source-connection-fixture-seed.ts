import {
	decodeZeropsSourceCredentialBundle,
	decodeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundleV2,
	ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX,
} from '@fabrika/provider-zerops'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { githubWebhookSecretLabel } from '../../control/src/github-connection-store'
import { Vault } from '../../control/src/vault'
import { PostgresDatabase } from '../../platform-node/src/sql-postgres'
import { LOCAL_SOURCE_CONNECTIONS, type LocalSourceConnectionFixture } from './source-connection-fixture'

const SOURCE_ENV = resolve(import.meta.dir, '..', '.state', 'source.env')

interface ExistingConnectionRow {
	connection_id: string
}

async function seed(): Promise<void> {
	const databaseUrl = required('FABRIKA_CONTROL_DATABASE_URL')
	const vaultKey = required('FABRIKA_CONTROL_VAULT_KEY')
	const sourceEnv = parseEnv(await readFile(SOURCE_ENV, 'utf8'))
	const credentials = await credentialDigests(sourceEnv)
	const database = PostgresDatabase.connect(databaseUrl, { max: 1 })
	try {
		const vault = await Vault.create(database, vaultKey)
		for (const connection of LOCAL_SOURCE_CONNECTIONS) {
			const existing = await database.prepare('SELECT connection_id FROM github_source_connections_keyed WHERE connection_id = ?')
				.bind(connection.connectionId)
				.first<ExistingConnectionRow>()
			if (existing !== null) continue
			const webhookSecretRef = await vault.putSecret(
				'platform',
				githubWebhookSecretLabel(connection.connectionId),
				randomBytes(32).toString('base64url'),
			)
			await insertConnection(database, connection, requiredMapValue(credentials, connection.connectionId), webhookSecretRef)
		}
	} finally {
		await database.close()
	}
}

async function credentialDigests(sourceEnv: Record<string, string>): Promise<Map<string, string>> {
	const values = new Map<string, string>()
	const legacy = requiredRecordValue(sourceEnv, 'GITHUB_APP_CREDENTIALS')
	decodeZeropsSourceCredentialBundle(legacy)
	values.set('local-legacy', await sha256ZeropsSourceCredentialBundle(legacy))
	for (const [name, value] of Object.entries(sourceEnv)) {
		if (!name.startsWith(ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX)) continue
		const bundle = decodeZeropsSourceCredentialBundleV2(value)
		values.set(bundle.connectionId, await sha256ZeropsSourceCredentialBundleV2(value))
	}
	return values
}

async function insertConnection(
	database: PostgresDatabase,
	connection: LocalSourceConnectionFixture,
	credentialSha256: string,
	webhookSecretRef: string,
): Promise<void> {
	await database.prepare(`INSERT INTO github_source_connections_keyed (
		connection_id, transport_kind, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		credential_sha256, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'all', '[]', '[]', 'local-fixture', 1, 1, 1)`)
		.bind(
			connection.connectionId,
			connection.transportKind,
			connection.githubAppId,
			`fabrika-${connection.connectionId}`,
			`https://github.com/apps/fabrika-${connection.connectionId}`,
			connection.owner,
			`fabrika-${connection.connectionId}`,
			credentialSha256,
			connection.transportKind === 'legacy-v1'
				? 'http://control.fabrika.localhost:18080/webhooks/github'
				: `http://control.fabrika.localhost:18080/webhooks/github/${connection.connectionId}`,
			webhookSecretRef,
			connection.installationId,
			connection.owner,
		)
		.run()
}

function parseEnv(source: string): Record<string, string> {
	const values: Record<string, string> = {}
	for (const line of source.split('\n')) {
		if (line === '') continue
		const separator = line.indexOf('=')
		if (separator <= 0) throw new Error('the local source fixture is invalid')
		const key = line.slice(0, separator)
		if (values[key] !== undefined) throw new Error('the local source fixture is invalid')
		values[key] = line.slice(separator + 1)
	}
	return values
}

function required(name: string): string {
	const value = process.env[name]
	if (value === undefined || value === '') throw new Error(`${name} is required`)
	return value
}

function requiredRecordValue(values: Record<string, string>, key: string): string {
	const value = values[key]
	if (value === undefined || value === '') throw new Error('the local source fixture is incomplete')
	return value
}

function requiredMapValue(values: ReadonlyMap<string, string>, key: string): string {
	const value = values.get(key)
	if (value === undefined || value === '') throw new Error('the local source fixture is incomplete')
	return value
}

if (import.meta.main) {
	seed().catch(() => {
		console.error('local source connection fixture setup failed')
		process.exit(1)
	})
}
