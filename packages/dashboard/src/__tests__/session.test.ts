import type { RpcFetch } from '@fabrika/app'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readConsoleSession, signOutUrl } from '../lib/session'
import { SignedIn } from '../routes/_layout'

const DISCOVERY = { version: 1, controlOrigin: 'https://console.example.com', iamIssuer: 'https://iam.example.com', provider: 'zerops' }

function consoleFetch(answers: { me: Response; discovery: Response }): RpcFetch {
	return async (input) => {
		const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname
		if (path === '/.well-known/fabrika-builder') return answers.discovery
		if (path === '/iam/admin/rpc') return answers.me
		throw new Error(`unexpected request to ${path}`)
	}
}

const meAnswer = () => Response.json({ result: { id: 'user-1', type: 'user', label: 'Ada@Example.com', permissions: [] } })

describe('console session', () => {
	test('names the signed-in person and links to IAM sign-out, which returns to IAM sign-in', async () => {
		const session = await readConsoleSession(consoleFetch({ me: meAnswer(), discovery: Response.json(DISCOVERY) }))

		expect(session.principal).toEqual({ id: 'user-1', label: 'Ada@Example.com' })
		const url = new URL(session.signOutUrl ?? '')
		expect(url.origin + url.pathname).toBe('https://iam.example.com/auth/logout')
		expect(url.searchParams.get('redirect')).toBe('https://iam.example.com/auth/login')
	})

	test('keeps sign-out when IAM does not answer who is signed in', async () => {
		const forbidden = Response.json({ error: { type: 'forbidden', message: 'forbidden' } }, { status: 403 })
		const session = await readConsoleSession(consoleFetch({ me: forbidden, discovery: Response.json(DISCOVERY) }))

		expect(session.principal).toBeNull()
		expect(session.signOutUrl).toBe(signOutUrl('https://iam.example.com'))
	})

	test('does not start a login bounce when the session is refused', async () => {
		const refused = Response.json({ error: { type: 'auth', message: 'sign in', loginUrl: 'https://iam.example.com/auth/login' } }, { status: 401 })
		const session = await readConsoleSession(consoleFetch({ me: refused, discovery: Response.json(DISCOVERY) }))

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
			session: { principal: { id: 'user-1', label: 'Ada@Example.com' }, signOutUrl: signOutUrl('https://iam.example.com') },
		}))

		expect(markup).toContain('>Ada@Example.com</span>')
		expect(markup).toContain('title="Signed in as Ada@Example.com (user-1)"')
		expect(markup).toContain('href="https://iam.example.com/auth/logout?redirect=https%3A%2F%2Fiam.example.com%2Fauth%2Flogin"')
		expect(markup).toContain('>Sign out</a>')
	})

	test('renders only what it knows', () => {
		expect(renderToStaticMarkup(createElement(SignedIn, { session: { principal: null, signOutUrl: null } }))).toBe('')
	})
})
