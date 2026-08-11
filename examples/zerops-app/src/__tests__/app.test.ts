// What this app is responsible for, proven without a database, without a proxy and without IAM.
//
// The gates themselves are NOT tested here — only the proxy evaluates them. What is tested is the
// half the proxy cannot do: verifying the injected token and authorizing a specific action on a
// specific workspace. See
// https://github.com/contember/fabrika-platform/blob/main/docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md.

import { createBunHandler } from '@fabrika/app/bun'
import { type AccessTokenClaims, type PermissionEntry, TOKEN_ALG } from '@fabrika/auth-core'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from 'jose'
import { notesApp, type OperationsBrowserFixture } from '../app'
import { createTokenReader, PROXY_TOKEN_HEADER } from '../authz'
import type { Note, NotesStore } from '../notes'

const ISSUER = 'https://iam.example.test'
const APP_ID = 'notes'

class MemoryNotes implements NotesStore {
	private readonly rows: Note[] = []
	list(workspace: string): Promise<Note[]> {
		return Promise.resolve(this.rows.filter((row) => row.workspace === workspace))
	}
	create(note: Note): Promise<void> {
		this.rows.push(note)
		return Promise.resolve()
	}
	remove(workspace: string, id: string): Promise<boolean> {
		const index = this.rows.findIndex((row) => row.workspace === workspace && row.id === id)
		if (index === -1) {
			return Promise.resolve(false)
		}
		this.rows.splice(index, 1)
		return Promise.resolve(true)
	}
}

class FailingNotes implements NotesStore {
	constructor(private readonly failure: Error) {}
	list(_workspace: string): Promise<Note[]> {
		return Promise.reject(this.failure)
	}
	create(_note: Note): Promise<void> {
		return Promise.reject(this.failure)
	}
	remove(_workspace: string, _id: string): Promise<boolean> {
		return Promise.reject(this.failure)
	}
}

let signingKey: KeyLike
let publicJwk: JWK
let sign: (claims: Partial<AccessTokenClaims> & { aud: string; iss: string }) => Promise<string>

beforeAll(async () => {
	const pair = await generateKeyPair(TOKEN_ALG, { extractable: true })
	signingKey = pair.privateKey
	publicJwk = { ...(await exportJWK(pair.publicKey)), alg: TOKEN_ALG, kid: 'test-1' }
	sign = (claims) =>
		new SignJWT({ perms: claims.perms ?? [], label: claims.label ?? null, ...(claims.ptype === undefined ? {} : { ptype: claims.ptype }) })
			.setProtectedHeader({ alg: TOKEN_ALG, kid: 'test-1' })
			.setIssuer(claims.iss)
			.setAudience(claims.aud)
			.setSubject(claims.sub ?? 'principal-1')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(signingKey)
})

const grant = (action: string, workspace?: string): PermissionEntry => ({
	action,
	scope: workspace === undefined ? null : { type: 'workspace', value: workspace },
	source: 'grant',
})

const handlerFor = (
	notes: NotesStore = new MemoryNotes(),
	operationsBrowser?: OperationsBrowserFixture,
): (request: Request) => Promise<Response> =>
	createBunHandler(
		notesApp,
		{
			readCaller: createTokenReader({ issuer: ISSUER, appId: APP_ID, keys: createLocalJWKSet({ keys: [publicJwk] }) }),
			notes,
			newId: () => 'note-1',
			operationsBrowser,
		},
		{ onBackgroundError: () => undefined },
	).fetch

const withToken = (url: string, token: string, init: RequestInit = {}): Request =>
	new Request(url, { ...init, headers: { ...(init.headers ?? {}), [PROXY_TOKEN_HEADER]: token } })

describe('public routes need no credential at all', () => {
	test('/healthz answers without a token — the platform health check carries none', async () => {
		const response = await handlerFor()(new Request('https://notes.test/healthz'))
		expect(response.status).toBe(200)
	})

	test('/public/* is anonymous, and an anonymous caller can do nothing', async () => {
		const response = await handlerFor()(new Request('https://notes.test/public/docs/info'))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ app: 'notes', caller: 'anonymous' })
	})
})

describe('the proxy-injected token is verified again, here', () => {
	test('a gated route with no token is 401 — the header is never trusted for its presence alone', async () => {
		const response = await handlerFor()(new Request('https://notes.test/api/notes?workspace=acme'))
		expect(response.status).toBe(401)
	})

	test('a token minted for ANOTHER app is rejected — this is what stops a leaked token being replayed', async () => {
		const token = await sign({ iss: ISSUER, aud: 'some-other-app', perms: [grant('notes.read')] })
		const response = await handlerFor()(withToken('https://notes.test/api/notes?workspace=acme', token))
		expect(response.status).toBe(401)
	})

	test('a token from another issuer is rejected', async () => {
		const token = await sign({ iss: 'https://evil.example.test', aud: APP_ID, perms: [grant('notes.read')] })
		const response = await handlerFor()(withToken('https://notes.test/api/notes?workspace=acme', token))
		expect(response.status).toBe(401)
	})

	test('a garbage token is 401 rather than a 500', async () => {
		const response = await handlerFor()(withToken('https://notes.test/api/notes?workspace=acme', 'not.a.jwt'))
		expect(response.status).toBe(401)
	})
})

describe('authorization is PER OBJECT — the check a per-path gate cannot make', () => {
	test('a grant scoped to one workspace does not reach another', async () => {
		const token = await sign({ iss: ISSUER, aud: APP_ID, perms: [grant('notes.read', 'acme')] })
		const handler = handlerFor()
		expect((await handler(withToken('https://notes.test/api/notes?workspace=acme', token))).status).toBe(200)
		expect((await handler(withToken('https://notes.test/api/notes?workspace=other', token))).status).toBe(403)
	})

	test('the `author` role writes but does not delete — separate actions, separately checked', async () => {
		const notes = new MemoryNotes()
		await notes.create({ id: 'note-0', workspace: 'acme', title: 'existing' })
		const handler = handlerFor(notes)
		const author = await sign({ iss: ISSUER, aud: APP_ID, perms: [grant('notes.read', 'acme'), grant('notes.write', 'acme')] })

		const created = await handler(
			withToken('https://notes.test/api/notes?workspace=acme', author, { method: 'POST', body: JSON.stringify({ title: 'hello' }) }),
		)
		expect(created.status).toBe(201)

		const deleted = await handler(withToken('https://notes.test/api/notes/note-0?workspace=acme', author, { method: 'DELETE' }))
		expect(deleted.status).toBe(403)
		expect(await notes.list('acme')).toHaveLength(2)
	})

	test('a `notes.*` grant covers every action in the namespace, including delete', async () => {
		const notes = new MemoryNotes()
		await notes.create({ id: 'note-0', workspace: 'acme', title: 'existing' })
		const admin = await sign({ iss: ISSUER, aud: APP_ID, perms: [grant('notes.*', 'acme')] })
		const response = await handlerFor(notes)(withToken('https://notes.test/api/notes/note-0?workspace=acme', admin, { method: 'DELETE' }))
		expect(response.status).toBe(200)
		expect(await notes.list('acme')).toHaveLength(0)
	})

	test('an `/api/*` request with no workspace is a 400, never "all workspaces"', async () => {
		const token = await sign({ iss: ISSUER, aud: APP_ID, perms: [grant('notes.read')] })
		const response = await handlerFor()(withToken('https://notes.test/api/notes', token))
		expect(response.status).toBe(400)
	})

	test('the UI route reports the readable workspaces; an unscoped grant reports null, meaning ALL', async () => {
		const scoped = await sign({ iss: ISSUER, aud: APP_ID, perms: [grant('notes.read', 'acme'), grant('notes.read', 'globex')] })
		const scopedBody: unknown = await (await handlerFor()(withToken('https://notes.test/', scoped))).json()
		expect(scopedBody).toEqual({ caller: 'principal-1', label: null, workspaces: ['acme', 'globex'] })

		const global = await sign({ iss: ISSUER, aud: APP_ID, perms: [grant('notes.read')] })
		const globalBody: unknown = await (await handlerFor()(withToken('https://notes.test/', global))).json()
		expect(globalBody).toEqual({ caller: 'principal-1', label: null, workspaces: null })
	})
})

describe('unhandled request errors stay opaque', () => {
	test('a backend error is reported internally but its message never reaches the response', async () => {
		const failure = new Error('postgres://user:secret@database.internal/notes')
		const reported: unknown[] = []
		const handler = createBunHandler(
			notesApp,
			{
				readCaller: createTokenReader({ issuer: ISSUER, appId: APP_ID, keys: createLocalJWKSet({ keys: [publicJwk] }) }),
				notes: new FailingNotes(failure),
				onError: (error) => reported.push(error),
			},
			{ onBackgroundError: () => undefined },
		).fetch
		const token = await sign({ iss: ISSUER, aud: APP_ID, perms: [grant('notes.read', 'acme')] })
		const response = await handler(withToken('https://notes.test/api/notes?workspace=acme', token))

		expect(response.status).toBe(500)
		expect(await response.json()).toEqual({ error: 'internal error' })
		expect(reported).toEqual([failure])
	})
})

describe('Operations browser SDK fixture', () => {
	test('requires a human and exposes only the managed DSN and release', async () => {
		const fixture = {
			dsn: 'https://0123456789abcdef0123456789abcdef@operations.test/123',
			release: 'release-123',
			script: 'console.info("SDK fixture")',
		}
		const handler = handlerFor(new MemoryNotes(), fixture)
		expect((await handler(new Request('https://notes.test/operations-sdk'))).status).toBe(401)

		const token = await sign({ iss: ISSUER, aud: APP_ID, perms: [] })
		const page = await handler(withToken('https://notes.test/operations-sdk', token))
		expect(page.status).toBe(200)
		expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
		const html = await page.text()
		expect(html).toContain('Capture managed error')
		expect(html).not.toContain(fixture.dsn)
		expect(html).not.toContain(fixture.release)

		const config = await handler(withToken('https://notes.test/operations-sdk/config', token))
		const body: unknown = await config.json()
		expect(body).toEqual({ dsn: fixture.dsn, release: fixture.release })
		expect(Object.keys(body ?? {})).toEqual(['dsn', 'release'])

		const script = await handler(withToken('https://notes.test/operations-sdk.js', token))
		expect(await script.text()).toBe(fixture.script)
	})

	test('does not expose an incomplete fixture', async () => {
		const token = await sign({ iss: ISSUER, aud: APP_ID, perms: [] })
		expect((await handlerFor()(withToken('https://notes.test/operations-sdk', token))).status).toBe(404)
		expect((await handlerFor()(withToken('https://notes.test/operations-sdk/config', token))).status).toBe(404)
		expect((await handlerFor()(withToken('https://notes.test/operations-sdk.js', token))).status).toBe(404)
	})
})
