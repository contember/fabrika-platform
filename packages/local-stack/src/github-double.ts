import type { SourceRepository } from '@fabrika/control/source'
import type { GitHubAppFetch } from '@fabrika/github-app'
import { createPublicKey, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { LOCAL_SOURCE_CONNECTIONS, localGitHubAppKey, type LocalGitHubApps } from './source-connection-fixture'

const GITHUB_API_ORIGIN = 'https://api.github.com'
const INSTALLATION_TOKEN_TTL_MS = 60 * 60 * 1000
/** GitHub refuses an App JWT that lives longer than ten minutes; `iat` may lead only by clock drift. */
const MAX_JWT_LIFETIME_SECONDS = 10 * 60
const MAX_JWT_CLOCK_DRIFT_SECONDS = 60

export interface GitHubDoubleInstallation {
	readonly id: number
	readonly owner: string
}

/** What GitHub knows about one App: the public half of its key and where it is installed. */
export interface GitHubDoubleApp {
	readonly appId: string
	readonly publicKeyPem: string
	readonly installations: readonly GitHubDoubleInstallation[]
}

export interface GitHubDoubleOptions {
	readonly apps: readonly GitHubDoubleApp[]
	/** Readable only with an installation token whose owner and repository scope name them. */
	readonly privateRepositories: readonly SourceRepository[]
	readonly now?: () => number
}

/**
 * The slice of GitHub's App API Control uses on the keyed path: an App JWT exchanged for a
 * repository-scoped installation token. It checks what GitHub checks — the JWT signature against that
 * App's own public key, that the installation belongs to the App, the token's repository scope — so a
 * local deploy cannot pass on a credential GitHub would refuse.
 */
export interface GitHubDouble {
	readonly appFetch: GitHubAppFetch
	/** True when `authorization` carries a live installation token scoped to `repository`. */
	canRead(authorization: string | null, repository: SourceRepository): boolean
}

interface InstallationToken {
	readonly owner: string
	readonly repositories: ReadonlySet<string>
	readonly expiresAt: number
}

const jwtHeaderSchema = z.object({ alg: z.literal('RS256') })
const jwtPayloadSchema = z.object({ iss: z.string(), iat: z.number().int(), exp: z.number().int() })
const tokenRequestSchema = z.object({
	repositories: z.array(z.string().min(1)).min(1),
	permissions: z.object({ contents: z.literal('read') }).strict(),
}).strict()

/** The double's App registry for the local fixture connections, from the keys the vault was seeded with. */
export function localGitHubDoubleApps(apps: LocalGitHubApps): GitHubDoubleApp[] {
	return LOCAL_SOURCE_CONNECTIONS.map((connection) => ({
		appId: connection.githubAppId,
		publicKeyPem: createPublicKey(localGitHubAppKey(apps, connection.connectionId)).export({ type: 'spki', format: 'pem' }).toString(),
		installations: [{ id: connection.installationId, owner: connection.owner }],
	}))
}

export async function createGitHubDouble(options: GitHubDoubleOptions): Promise<GitHubDouble> {
	const now = options.now ?? Date.now
	const apps = new Map<string, { publicKey: CryptoKey; installations: ReadonlyMap<number, string> }>()
	for (const app of options.apps) {
		apps.set(app.appId, {
			publicKey: await crypto.subtle.importKey(
				'spki',
				createPublicKey(app.publicKeyPem).export({ type: 'spki', format: 'der' }),
				{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
				false,
				['verify'],
			),
			installations: new Map(app.installations.map((installation) => [installation.id, installation.owner.toLowerCase()])),
		})
	}
	const privateRepositories = new Set(options.privateRepositories.map((repository) => repositoryKey(repository.owner, repository.name)))
	const tokens = new Map<string, InstallationToken>()

	const verifiedApp = async (authorization: string | null) => {
		const parts = bearer(authorization)?.split('.')
		if (parts?.length !== 3) return undefined
		const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = parts
		const header = jwtHeaderSchema.safeParse(decodeSegment(encodedHeader))
		const payload = jwtPayloadSchema.safeParse(decodeSegment(encodedPayload))
		if (!header.success || !payload.success) return undefined
		const app = apps.get(payload.data.iss)
		if (app === undefined) return undefined
		const signed = await crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			app.publicKey,
			Buffer.from(encodedSignature, 'base64url'),
			new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
		)
		const nowSeconds = Math.floor(now() / 1000)
		const { iat, exp } = payload.data
		if (!signed || iat > nowSeconds + MAX_JWT_CLOCK_DRIFT_SECONDS || exp <= nowSeconds || exp - iat > MAX_JWT_LIFETIME_SECONDS) return undefined
		return app
	}

	const mint = async (request: Request, installationId: number): Promise<Response> => {
		const app = await verifiedApp(request.headers.get('authorization'))
		if (app === undefined) return githubError(401, 'A JSON web token could not be decoded')
		const owner = app.installations.get(installationId)
		if (owner === undefined) return githubError(404, 'Not Found')
		const body = tokenRequestSchema.safeParse(await request.json().catch(() => undefined))
		if (!body.success || !body.data.repositories.every((name) => privateRepositories.has(repositoryKey(owner, name)))) {
			return githubError(422, 'The permissions or repositories requested are not granted to this installation.')
		}
		const token = `ghs_${randomBytes(24).toString('hex')}`
		const expiresAt = now() + INSTALLATION_TOKEN_TTL_MS
		tokens.set(token, { owner, repositories: new Set(body.data.repositories.map((name) => name.toLowerCase())), expiresAt })
		return Response.json({
			token,
			expires_at: new Date(expiresAt).toISOString(),
			permissions: { contents: 'read' },
			repository_selection: 'selected',
		}, { status: 201 })
	}

	return {
		appFetch: async (input, init) => {
			const request = new Request(input, init)
			const url = new URL(request.url)
			const match = /^\/app\/installations\/([1-9][0-9]{0,15})\/access_tokens$/.exec(url.pathname)
			if (url.origin !== GITHUB_API_ORIGIN || request.method !== 'POST' || match?.[1] === undefined || url.search !== '') {
				return githubError(404, 'Not Found')
			}
			return await mint(request, Number(match[1]))
		},
		canRead: (authorization, repository) => {
			const token = bearer(authorization)
			const grant = token === undefined ? undefined : tokens.get(token)
			return grant !== undefined && grant.expiresAt > now() && grant.owner === repository.owner.toLowerCase()
				&& grant.repositories.has(repository.name.toLowerCase())
		},
	}
}

function repositoryKey(owner: string, name: string): string {
	return `${owner.toLowerCase()}/${name.toLowerCase()}`
}

function bearer(authorization: string | null): string | undefined {
	return authorization?.startsWith('Bearer ') === true ? authorization.slice('Bearer '.length) : undefined
}

function decodeSegment(segment: string): unknown {
	try {
		return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
	} catch {
		return undefined
	}
}

function githubError(status: number, message: string): Response {
	return Response.json({ message, documentation_url: 'https://docs.github.com/rest' }, { status })
}
