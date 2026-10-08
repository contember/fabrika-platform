import { generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

export interface LocalSourceConnectionFixture {
	readonly connectionId: string
	readonly githubAppId: string
	readonly owner: string
	readonly installationId: number
}

/**
 * Two independent keyed connections, so local routing has to select the exact one. The first is installed
 * on `fabrika-local`, the owner of the private application fixture; the second owns nothing local.
 */
export const LOCAL_SOURCE_CONNECTIONS: readonly LocalSourceConnectionFixture[] = [
	{ connectionId: 'local-keyed-alpha', githubAppId: '1002', owner: 'fabrika-local', installationId: 10_002 },
	{ connectionId: 'local-keyed-beta', githubAppId: '1003', owner: 'local-beta', installationId: 10_003 },
]

/** Each fixture App's private key, generated once per `.state/`: Control's vault holds it, the GitHub double only its public half. */
export const LOCAL_GITHUB_APPS_FILE = 'github-apps.json'

const localGitHubAppsSchema = z.object({
	version: z.literal(1),
	apps: z.array(z.object({ connectionId: z.string().min(1), privateKeyPem: z.string().startsWith('-----BEGIN PRIVATE KEY-----') }).strict()),
}).strict()

export type LocalGitHubApps = z.infer<typeof localGitHubAppsSchema>

/** Local fixture state that no longer matches the fixture; its message names no value, so it may be printed. */
export class StaleLocalFixtureError extends Error {
	constructor(subject: string) {
		super(`${subject} differs from the fixture; explicitly reset the local stack`)
	}
}

/** The fixture App key of one connection; a connection with none is a stale `.state/`. */
export function localGitHubAppKey(apps: LocalGitHubApps, connectionId: string): string {
	const app = apps.apps.find((candidate) => candidate.connectionId === connectionId)
	if (app === undefined) throw new StaleLocalFixtureError('the local GitHub App key file')
	return app.privateKeyPem
}

export async function readLocalGitHubApps(stateDirectory: string): Promise<LocalGitHubApps> {
	const parsed = localGitHubAppsSchema.safeParse(await Bun.file(resolve(stateDirectory, LOCAL_GITHUB_APPS_FILE)).json())
	if (!parsed.success) throw new StaleLocalFixtureError('the local GitHub App key file')
	const apps = parsed.data
	for (const connection of LOCAL_SOURCE_CONNECTIONS) localGitHubAppKey(apps, connection.connectionId)
	if (apps.apps.length !== LOCAL_SOURCE_CONNECTIONS.length) throw new StaleLocalFixtureError('the local GitHub App key file')
	return apps
}

/** Generate one key per connection when `.state/` has none; an existing file is kept, because the vault already holds it. */
export async function ensureLocalGitHubApps(stateDirectory: string): Promise<LocalGitHubApps> {
	const path = resolve(stateDirectory, LOCAL_GITHUB_APPS_FILE)
	if (existsSync(path)) return readLocalGitHubApps(stateDirectory)
	const apps: LocalGitHubApps = {
		version: 1,
		apps: LOCAL_SOURCE_CONNECTIONS.map((connection) => ({
			connectionId: connection.connectionId,
			privateKeyPem: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
		})),
	}
	await Bun.write(path, `${JSON.stringify(apps, null, '\t')}\n`, { mode: 0o600 })
	return apps
}
