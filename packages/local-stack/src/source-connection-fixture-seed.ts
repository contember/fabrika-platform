import { githubAppCredentialSecretLabel, githubWebhookSecretLabel } from '@fabrika/control/github-connection-store'
import { encodeGitHubAppCredential } from '@fabrika/control/source'
import { Vault } from '@fabrika/control/vault'
import { PostgresDatabase } from '@fabrika/platform-node'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import {
	LOCAL_SOURCE_CONNECTIONS,
	localGitHubAppKey,
	type LocalGitHubApps,
	type LocalSourceConnectionFixture,
	readLocalGitHubApps,
	StaleLocalFixtureError,
} from './source-connection-fixture'

interface ExistingConnectionRow {
	app_id: string
	app_owner: string
	installation_id: number
	installation_account_login: string
	app_credential_ref: string
}

export interface SeedLocalSourceConnectionsInput {
	readonly database: PostgresDatabase
	readonly vault: Vault
	readonly apps: LocalGitHubApps
	/** The first connection holds this webhook secret, so the smoke can sign a push to its scoped route. */
	readonly webhookSecret: string
}

/** Two keyed connections whose App keys live in Control's vault, as a console setup would leave them (ADR-0029). */
export async function seedLocalSourceConnections(input: SeedLocalSourceConnectionsInput): Promise<void> {
	const { database, vault, apps } = input
	for (const [index, connection] of LOCAL_SOURCE_CONNECTIONS.entries()) {
		const credential = encodeGitHubAppCredential({ appId: connection.githubAppId, privateKeyPem: localGitHubAppKey(apps, connection.connectionId) })
		const existing = await database.prepare(`SELECT app_id, app_owner, installation_id, installation_account_login, app_credential_ref
			FROM github_source_connections_keyed WHERE connection_id = ?`)
			.bind(connection.connectionId)
			.first<ExistingConnectionRow>()
		if (existing !== null) {
			await assertSeeded(vault, connection, existing, credential)
			continue
		}
		const appCredentialRef = await vault.putSecret('platform', githubAppCredentialSecretLabel(connection.connectionId), credential)
		const webhookSecretRef = await vault.putSecret(
			'platform',
			githubWebhookSecretLabel(connection.connectionId),
			index === 0 ? input.webhookSecret : randomBytes(32).toString('base64url'),
		)
		await insertConnection(database, connection, appCredentialRef, webhookSecretRef)
	}
}

/** A stack seeded before each fixture App had its own key, or with other coordinates, cannot mint against the double. */
async function assertSeeded(
	vault: Vault,
	connection: LocalSourceConnectionFixture,
	existing: ExistingConnectionRow,
	credential: string,
): Promise<void> {
	const stored = await vault.getSecretForPurpose(existing.app_credential_ref, {
		scope: 'platform',
		label: githubAppCredentialSecretLabel(connection.connectionId),
	})
	if (
		existing.app_id !== connection.githubAppId || existing.app_owner !== connection.owner
		|| existing.installation_account_login !== connection.owner || existing.installation_id !== connection.installationId
		|| stored !== credential
	) {
		throw new StaleLocalFixtureError(`local source connection ${connection.connectionId}`)
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

async function main(): Promise<void> {
	const database = PostgresDatabase.connect(required('FABRIKA_CONTROL_DATABASE_URL'), { max: 1 })
	try {
		await seedLocalSourceConnections({
			database,
			vault: await Vault.create(database, required('FABRIKA_CONTROL_VAULT_KEY')),
			apps: await readLocalGitHubApps(resolve(import.meta.dir, '..', '.state')),
			webhookSecret: required('GITHUB_WEBHOOK_SECRET'),
		})
	} finally {
		await database.close()
	}
}

function required(name: string): string {
	const value = process.env[name]
	if (value === undefined || value === '') throw new Error(`${name} is required`)
	return value
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		// Only this module's own diagnostics are printed: a driver error may carry the database URL.
		console.error(error instanceof StaleLocalFixtureError ? error.message : 'local source connection fixture setup failed')
		process.exit(1)
	})
}
