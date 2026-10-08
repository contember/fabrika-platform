import { githubAppCredentialSecretLabel, githubWebhookSecretLabel } from '@fabrika/control/github-connection-store'
import { encodeGitHubAppCredential } from '@fabrika/control/source'
import { Vault } from '@fabrika/control/vault'
import { PostgresDatabase } from '@fabrika/platform-node'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { LOCAL_SOURCE_CONNECTIONS, type LocalSourceConnectionFixture } from './source-connection-fixture'

interface ExistingConnectionRow {
	connection_id: string
}

/** Two keyed connections whose App keys live in Control's vault, as a console setup would leave them (ADR-0029). */
async function seed(): Promise<void> {
	const databaseUrl = required('FABRIKA_CONTROL_DATABASE_URL')
	const vaultKey = required('FABRIKA_CONTROL_VAULT_KEY')
	// No GitHub App is reachable locally, so one throwaway key serves every connection.
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
	const database = PostgresDatabase.connect(databaseUrl, { max: 1 })
	try {
		const vault = await Vault.create(database, vaultKey)
		for (const [index, connection] of LOCAL_SOURCE_CONNECTIONS.entries()) {
			const existing = await database.prepare('SELECT connection_id FROM github_source_connections_keyed WHERE connection_id = ?')
				.bind(connection.connectionId)
				.first<ExistingConnectionRow>()
			if (existing !== null) continue
			const appCredentialRef = await vault.putSecret(
				'platform',
				githubAppCredentialSecretLabel(connection.connectionId),
				encodeGitHubAppCredential({ appId: connection.githubAppId, privateKeyPem: privateKey }),
			)
			// The smoke signs its push with control's own `GITHUB_WEBHOOK_SECRET`, so the first connection
			// holds exactly that value; every other connection gets an unrelated one.
			const webhookSecretRef = await vault.putSecret(
				'platform',
				githubWebhookSecretLabel(connection.connectionId),
				index === 0 ? required('GITHUB_WEBHOOK_SECRET') : randomBytes(32).toString('base64url'),
			)
			await insertConnection(database, connection, appCredentialRef, webhookSecretRef)
		}
	} finally {
		await database.close()
	}
}

async function insertConnection(
	database: PostgresDatabase,
	connection: LocalSourceConnectionFixture,
	appCredentialRef: string,
	webhookSecretRef: string,
): Promise<void> {
	await database.prepare(`INSERT INTO github_source_connections_keyed (
		connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'all', '[]', '[]', 'local-fixture', 1, 1, 1)`)
		.bind(
			connection.connectionId,
			connection.githubAppId,
			`fabrika-${connection.connectionId}`,
			`https://github.com/apps/fabrika-${connection.connectionId}`,
			connection.owner,
			`fabrika-${connection.connectionId}`,
			appCredentialRef,
			`http://control.fabrika.localhost:18080/webhooks/github/${connection.connectionId}`,
			webhookSecretRef,
			connection.installationId,
			connection.owner,
		)
		.run()
}

function required(name: string): string {
	const value = process.env[name]
	if (value === undefined || value === '') throw new Error(`${name} is required`)
	return value
}

if (import.meta.main) {
	seed().catch(() => {
		console.error('local source connection fixture setup failed')
		process.exit(1)
	})
}
