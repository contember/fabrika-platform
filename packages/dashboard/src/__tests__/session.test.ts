import type { RpcFetch } from '@fabrika/app'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readConsoleSession, signOutUrl } from '../lib/session'
import { SignedIn } from '../routes/_layout'

const DISCOVERY = { version: 1, controlOrigin: 'https://console.example.com', iamIssuer: 'https://iam.example.com', provider: 'zerops' }

interface Answers {
	me: Response
	discovery: Response
	access?: Response
	people?: Response
}

/** Answers each RPC by its method, so one IAM path serves `me` and `appPeople.apps` apart. */
function consoleFetch(answers: Answers): RpcFetch {
	return async (input, init) => {
		const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname
		if (path === '/.well-known/fabrika-builder') return answers.discovery
		const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
		const method = body !== null && typeof body === 'object' && 'method' in body ? body.method : null
		if (path === '/api/rpc' && method === 'consoleAccess') return answers.access ?? unavailable()
		if (path === '/iam/admin/rpc' && method === 'me') return answers.me
		if (path === '/iam/admin/rpc' && method === 'appPeople.apps') return answers.people ?? unavailable()
		throw new Error(`unexpected request to ${path} ${String(method)}`)
	}
}

const unavailable = () => new Response('unavailable', { status: 503 })
const forbidden = () => Response.json({ error: { type: 'forbidden', message: 'forbidden' } }, { status: 403 })
const meAnswer = () => Response.json({ result: { id: 'user-1', type: 'user', label: 'Ada@Example.com', permissions: [] } })
const accessAnswer = (access: object) => Response.json({ result: access })
const peopleAnswer = (apps: number) =>
	Response.json({ result: { items: Array.from({ length: apps }, (_, i) => ({ app: `app-${i}`, displayName: null, roles: [] })) } })

describe('console session', () => {
	test('names the signed-in person and links to IAM sign-out, which returns to IAM sign-in', async () => {
		const session = await readConsoleSession(consoleFetch({ me: meAnswer(), discovery: Response.json(DISCOVERY) }))

		expect(session.principal).toEqual({ id: 'user-1', label: 'Ada@Example.com' })
		const url = new URL(session.signOutUrl ?? '')
		expect(url.origin + url.pathname).toBe('https://iam.example.com/auth/logout')
		expect(url.searchParams.get('redirect')).toBe('https://iam.example.com/auth/login')
	})

	test('keeps sign-out when neither Control nor IAM says who is signed in', async () => {
		const session = await readConsoleSession(consoleFetch({ me: forbidden(), discovery: Response.json(DISCOVERY) }))

		expect(session.principal).toBeNull()
		expect(session.signOutUrl).toBe(signOutUrl('https://iam.example.com'))
	})

	test('names a caller who is no IAM administrator from Control, and reads what it may use', async () => {
		const access = { principal: { id: 'user-2', label: 'bob@example.com' }, global: [], scopes: [] }
		const session = await readConsoleSession(consoleFetch({
			me: forbidden(),
			access: accessAnswer(access),
			people: peopleAnswer(0),
			discovery: Response.json(DISCOVERY),
		}))

		expect(session.principal).toEqual({ id: 'user-2', label: 'bob@example.com' })
		expect(session.access).toEqual(access)
		expect(session.iamAdmin).toBe(false)
		expect(session.administersPeople).toBe(false)
	})

	test('an IAM administrator who administers an application is both', async () => {
		const session = await readConsoleSession(consoleFetch({ me: meAnswer(), people: peopleAnswer(1), discovery: Response.json(DISCOVERY) }))

		expect(session.iamAdmin).toBe(true)
		expect(session.administersPeople).toBe(true)
	})

	test('a service that does not answer leaves its part unknown, never refused', async () => {
		const session = await readConsoleSession(consoleFetch({ me: unavailable(), discovery: Response.json(DISCOVERY) }))

		expect(session.access).toBeNull()
		expect(session.iamAdmin).toBeNull()
		expect(session.administersPeople).toBeNull()
	})

	test('does not start a login bounce when the session is refused', async () => {
		const refused = Response.json({ error: { type: 'auth', message: 'sign in', loginUrl: 'https://iam.example.com/auth/login' } }, { status: 401 })
		const session = await readConsoleSession(consoleFetch({ me: refused, access: refused.clone(), discovery: Response.json(DISCOVERY) }))

		expect(session.principal).toBeNull()
	})

	test('offers no sign-out when the installation publishes no IAM origin', async () => {
		const unavailable = new Response('builder connection unavailable', { status: 503 })
		expect((await readConsoleSession(consoleFetch({ me: meAnswer(), discovery: unavailable }))).signOutUrl).toBeNull()

		const malformed = Response.json({ ...DISCOVERY, iamIssuer: 'javascript:alert(1)' })
		expect((await readConsoleSession(consoleFetch({ me: meAnswer(), discovery: malformed }))).signOutUrl).toBeNull()
	})

	test('renders the label with the id in its title, and the sign-out link', () => {
		const markup = renderToStaticMarkup(createElement(SignedIn, {
			session: {
				principal: { id: 'user-1', label: 'Ada@Example.com' },
				signOutUrl: signOutUrl('https://iam.example.com'),
				access: null,
				iamAdmin: null,
				administersPeople: null,
			},
		}))

		expect(markup).toContain('>Ada@Example.com</span>')
		expect(markup).toContain('title="Signed in as Ada@Example.com (user-1)"')
		expect(markup).toContain('href="https://iam.example.com/auth/logout?redirect=https%3A%2F%2Fiam.example.com%2Fauth%2Flogin"')
		expect(markup).toContain('>Sign out</a>')
	})

	test('renders only what it knows', () => {
		const session = { principal: null, signOutUrl: null, access: null, iamAdmin: null, administersPeople: null }
		expect(renderToStaticMarkup(createElement(SignedIn, { session }))).toBe('')
	})
})
