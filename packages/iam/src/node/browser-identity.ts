/** Local browser-test identity seeding. This file is not mounted as an HTTP route. */
import { chmodSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateToken, hashToken } from '../secret'
import { createRuntime } from './runtime'

const OUTPUT_DIR = resolve(import.meta.dir, '..', '..', '..', 'local-stack', '.state', 'browser-identities')
const SESSION_TTL_SECONDS = 60 * 60

export type BrowserIdentityRole = 'admin' | 'operations-notes'

function parseRole(value: string | undefined): BrowserIdentityRole {
	if (value === 'admin' || value === 'operations-notes') return value
	throw new Error('role must be admin or operations-notes')
}

function parseOutputId(value: string | undefined): string {
	if (value === undefined || !/^[0-9a-f-]{36}$/.test(value)) throw new Error('output id must be a UUID')
	return value
}

async function createBrowserIdentity(role: BrowserIdentityRole, outputId: string): Promise<void> {
	const runtime = createRuntime()
	try {
		const email = `browser-${role}-${outputId}@fabrika.local`
		const principal = await runtime.env.REPOSITORIES.principals.createUser(`browser-${outputId}`, email)
		await runtime.env.REPOSITORIES.grants.createGrant({
			principalId: principal.id,
			app: role === 'admin' ? null : 'vozka',
			permissions: role === 'admin' ? ['*'] : ['operations.*'],
			...(role === 'operations-notes' ? { scopeType: 'app', scopeValue: 'browser-notes' } : {}),
		})

		const session = generateToken()
		const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
		// A session is refused once its method is disabled, and this stack runs password-only (OIDC off),
		// so the seeded login has to be a password one — which also means no IdP subject.
		await runtime.env.REPOSITORIES.sessions.createSession({
			tokenHash: await hashToken(session),
			principalId: principal.id,
			email,
			authenticationMethod: 'password',
			expiresAt,
		})

		mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 })
		chmodSync(OUTPUT_DIR, 0o700)
		const output = resolve(OUTPUT_DIR, `${outputId}.json`)
		await Bun.write(output, `${JSON.stringify({ role, principalId: principal.id, label: email, session, expiresAt })}\n`)
		chmodSync(output, 0o600)
	} finally {
		await runtime.shutdown()
	}
}

if (import.meta.main) {
	try {
		await createBrowserIdentity(parseRole(Bun.argv[2]), parseOutputId(Bun.argv[3]))
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'browser identity setup failed')
		process.exit(1)
	}
}
