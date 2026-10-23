// IAM speaks the application's language (`locale` and `displayName` in its contract), and an action or an invitation
// that keeps an application ends in it. The words come from IAM's catalog; the application chooses only the language
// and the name, and the name is escaped wherever it lands.

import { AUTH_CALLBACK_PATH, AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM, SESSION_COOKIE } from '@fabrika/auth-core'
import type { EmailMessage } from '@fabrika/email'
import { describe, expect, test } from 'bun:test'
import { handleAuth } from '../auth/routes'
import { assignMember, createScope, requestDelegation } from '../membership'
import { pkceChallenge } from '../oidc'
import type { PasswordHasher, StoredPasswordHash } from '../password-crypto'
import { hashToken } from '../secret'
import type { Services } from '../services'
import { createHarness, type Harness, seedUser } from './helpers/harness'
import {
	APP,
	CALLER_ENV,
	CapturingEmail,
	CREATE_ENDPOINT,
	INVITE_ENDPOINT,
	membershipFixture,
	NOTES_SCHEMA,
	ORIGIN,
	PendingWork,
} from './helpers/membership'

const ISSUER = 'https://iam.test'
const PORTAL = 'portal@prod'
const PORTAL_ORIGIN = 'https://portal.test'
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'stage' }
const HANDOFF_STATE = 'state-state-state1'
const HANDOFF_CHALLENGE = await pkceChallenge('browser-held-verifier-browser-held-verifier-1')
const PASSWORD = 'a sufficiently long passphrase'

class PlainHasher implements PasswordHasher {
	async hash(password: string): Promise<StoredPasswordHash> {
		return { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: `hash:${password}` }
	}

	async verify(password: string, stored: StoredPasswordHash) {
		return { valid: stored.passwordHash === `hash:${password}`, needsRehash: false }
	}
}

interface Portal {
	readonly h: Harness
	readonly services: Services
	readonly email: CapturingEmail
	readonly ctx: PendingWork
	send(request: Request): Promise<Response>
}

/** An installation with password sign-in, mail, and the portal application as its contract declares it. */
async function portal(presentation: { locale: string | null; displayName: string | null }, origins = [PORTAL_ORIGIN]): Promise<Portal> {
	const h = createHarness()
	const email = new CapturingEmail()
	const services = h.makeServices({
		issuer: ISSUER,
		environment: 'stage',
		authentication: { oidc: false, password: true },
		passwordHasher: new PlainHasher(),
		email,
	})
	await services.repositories.appSchema.reconcileAppSchema({ app: PORTAL, scopes: [], actions: [{ action: 'portal.read' }], roles: [], presentation })
	if (origins.length > 0) await services.repositories.handoff.setReturnOrigins(PORTAL, origins)
	const ctx = new PendingWork()
	return { h, services, email, ctx, send: (request) => handleAuth(request, services, AUTH_ENV, ctx) }
}

async function partner(p: Portal): Promise<string> {
	const id = seedUser(p.h.sqlite, { sub: null, email: 'partner@example.test' })
	await p.services.repositories.passwords.enableEnrollment(id)
	await p.services.repositories.passwords.upsertCredential(id, await new PlainHasher().hash('the old long passphrase'))
	return id
}

function handoffLogin(): Request {
	const url = new URL('/auth/login', ISSUER)
	url.searchParams.set('app', PORTAL)
	url.searchParams.set('redirect', `${PORTAL_ORIGIN}/companies`)
	url.searchParams.set(AUTH_HANDOFF_STATE_PARAM, HANDOFF_STATE)
	url.searchParams.set(AUTH_HANDOFF_CHALLENGE_PARAM, HANDOFF_CHALLENGE)
	return new Request(url)
}

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Request {
	return new Request(new URL(path, ISSUER), {
		method: 'POST',
		headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
		body: new URLSearchParams(fields),
	})
}

function lastMail(email: CapturingEmail): EmailMessage {
	const message = email.messages.at(-1)
	if (message === undefined) throw new Error('no mail was sent')
	return message
}

/** The one-time link of a mail: its address and its token. */
function linkOf(message: EmailMessage): { url: URL; token: string } {
	const link = /https?:\/\/\S+/.exec(message.text)?.[0]
	if (link === undefined) throw new Error('no link in the mail')
	const url = new URL(link)
	const token = new URLSearchParams(url.hash.slice(1)).get('token')
	if (token === null) throw new Error('no token in the link')
	return { url, token }
}

function formAction(response: Response): string | undefined {
	return /form-action ([^;]*);/.exec(response.headers.get('content-security-policy') ?? '')?.[1]
}

function sessionCookie(response: Response): string {
	const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
	if (header === undefined) throw new Error('no session cookie')
	return header.split(';')[0] ?? ''
}

describe('a cs application', () => {
	test('its sign-in, forgot password, reset mail and set-password page are Czech, and the reset ends in the application', async () => {
		const p = await portal({ locale: 'cs', displayName: 'Partnerský portál' })
		await partner(p)

		const signIn = await p.send(handoffLogin())
		const signInHtml = await signIn.text()
		expect(signInHtml).toContain('<html lang="cs">')
		expect(signInHtml).toContain('<h1>Přihlášení do aplikace Partnerský portál</h1>')
		expect(signInHtml).toContain('href="/auth/forgot-password?app=portal%40prod">Zapomenuté heslo?</a>')
		expect(signInHtml).toMatch(/<span class="runs-on">Běží na platformě <svg[^>]*>.*?<\/svg> fabrika<\/span>/)
		expect(formAction(signIn)).toBe(`'self' ${PORTAL_ORIGIN}`)

		const forgot = await p.send(new Request(`${ISSUER}/auth/forgot-password?app=${encodeURIComponent(PORTAL)}`))
		const forgotHtml = await forgot.text()
		expect(forgotHtml).toContain('<html lang="cs">')
		expect(forgotHtml).toContain('Zadejte adresu, kterou se přihlašujete do aplikace Partnerský portál.')
		expect(forgotHtml).toContain('action="/auth/forgot-password?app=portal%40prod"')
		expect(formAction(forgot)).toBe(`'self'`)

		const requested = await p.send(post(`/auth/forgot-password?app=${encodeURIComponent(PORTAL)}`, { email: 'partner@example.test' }))
		const requestedHtml = await requested.text()
		expect(requestedHtml).toContain('Žádost přijata')
		expect(requestedHtml).toContain(`href="${PORTAL_ORIGIN}/">Zpět na přihlášení</a>`)
		await p.ctx.settle()

		const mail = lastMail(p.email)
		expect(mail.subject).toBe('Obnovení hesla pro aplikaci Partnerský portál')
		expect(mail.text).toStartWith('Tímto jednorázovým odkazem si obnovíte heslo:')
		const { url, token } = linkOf(mail)
		expect(`${url.origin}${url.pathname}${url.search}`).toBe(`${ISSUER}/auth/password/reset?app=portal%40prod`)
		expect((await p.services.repositories.passwords.inspectActionToken(await hashToken(token), 'reset'))?.app).toBe(PORTAL)

		const page = await p.send(new Request(url))
		const pageHtml = await page.text()
		expect(pageHtml).toContain('<html lang="cs">')
		expect(pageHtml).toContain('<h1>Obnovte si heslo</h1>')
		expect(pageHtml).toContain('nejen pro aplikaci Partnerský portál')
		expect(pageHtml).toContain('action="/auth/password/reset?app=portal%40prod"')
		expect(pageHtml).not.toContain(token)
		// The completed reset answers a redirect to the application, which `form-action` must admit (Chromium).
		expect(formAction(page)).toBe(`'self' ${PORTAL_ORIGIN}`)

		const weak = await p.send(post(`/auth/password/reset?app=${encodeURIComponent(PORTAL)}`, { token, password: 'short' }))
		expect(weak.status).toBe(400)
		expect(await weak.text()).toContain('Použijte alespoň 15 znaků.')

		const reset = await p.send(post(`/auth/password/reset?app=${encodeURIComponent(PORTAL)}`, { token, password: PASSWORD }))
		expect(reset.status).toBe(302)
		expect(reset.headers.get('location')).toBe(`${PORTAL_ORIGIN}/`)

		// The application's proxy bounces the browser to IAM's sign-in, which the session just issued makes silent.
		const handoff = await p.send(new Request(handoffLogin(), { headers: { Cookie: sessionCookie(reset) } }))
		expect(handoff.status).toBe(302)
		const callback = new URL(handoff.headers.get('location') ?? '')
		expect(`${callback.origin}${callback.pathname}`).toBe(`${PORTAL_ORIGIN}${AUTH_CALLBACK_PATH}`)
	})

	test('a refused sign-in stays in Czech, and IAM keeps its own wording for the rest', async () => {
		const p = await portal({ locale: 'cs', displayName: 'Partnerský portál' })
		await partner(p)
		const login = handoffLogin()
		const params = new URL(login.url).searchParams
		const refused = await p.send(post('/auth/login', {
			app: PORTAL,
			redirect: params.get('redirect') ?? '',
			state: HANDOFF_STATE,
			code_challenge: HANDOFF_CHALLENGE,
			email: 'partner@example.test',
			password: 'not the password at all',
		}))
		expect(refused.status).toBe(401)
		const html = await refused.text()
		expect(html).toContain('<html lang="cs">')
		expect(html).toContain('Neplatný e-mail nebo heslo.')
		expect(html).toContain('data-label-hide="Skrýt"')
	})
})

describe("a cs application's refusals", () => {
	test('a handoff without its proof, or to an unregistered address, is refused in Czech and names the address', async () => {
		const p = await portal({ locale: 'cs', displayName: 'Partnerský portál' })
		const unproven = new URL(handoffLogin().url)
		unproven.searchParams.delete(AUTH_HANDOFF_CHALLENGE_PARAM)
		const refused = await p.send(new Request(unproven))
		expect(refused.status).toBe(400)
		const html = await refused.text()
		expect(html).toContain('<html lang="cs">')
		expect(html).toContain('Pro tuto aplikaci chybí platný doklad předání z prohlížeče.')

		const elsewhere = new URL(handoffLogin().url)
		elsewhere.searchParams.set('redirect', 'https://evil.test/x')
		const unregistered = await p.send(new Request(elsewhere))
		expect(unregistered.status).toBe(400)
		expect(await unregistered.text()).toContain('https://evil.test není registrovaná návratová adresa této aplikace.')
	})

	test('a refused password sign-in keeps its status and its auth-log reason', async () => {
		const p = await portal({ locale: 'cs', displayName: 'Partnerský portál' })
		const refused = await p.send(post('/auth/login', {
			app: PORTAL,
			redirect: 'https://evil.test/x',
			state: HANDOFF_STATE,
			code_challenge: HANDOFF_CHALLENGE,
			email: 'partner@example.test',
			password: PASSWORD,
		}))
		expect(refused.status).toBe(400)
		expect(await refused.text()).toContain('není registrovaná návratová adresa této aplikace.')
		const rows = p.h.sqlite.query<{ reason: string }, []>("SELECT reason FROM auth_log WHERE decision = 'deny'").all()
		expect(rows.map((row) => row.reason)).toEqual(['handoff_refused'])
	})

	test('a cross-site recovery, set-password or invitation post is refused in Czech, with 403', async () => {
		const p = await portal({ locale: 'cs', displayName: 'Partnerský portál' })
		const query = `?app=${encodeURIComponent(PORTAL)}`
		for (const path of ['/auth/forgot-password', '/auth/password/reset', '/auth/invitations/accept']) {
			const response = await p.send(
				post(`${path}${query}`, { token: 'x'.repeat(43), email: 'partner@example.test' }, { 'Sec-Fetch-Site': 'cross-site' }),
			)
			expect(response.status).toBe(403)
			const html = await response.text()
			expect(html).toContain('<html lang="cs">')
			expect(html).toContain('Neplatný původ požadavku.')
		}
		expect(p.email.messages).toEqual([])
	})

	test('an unknown application is refused in English', async () => {
		const p = await portal({ locale: 'cs', displayName: 'Partnerský portál' })
		const url = new URL(handoffLogin().url)
		url.searchParams.set('app', 'nowhere@prod')
		const refused = await p.send(new Request(url))
		expect(refused.status).toBe(400)
		const html = await refused.text()
		expect(html).toContain('<html lang="en">')
		expect(html).toContain('is not a registered return origin for this app.')
	})
})

describe('the language falls back to the installation default', () => {
	test('an application without a locale is English, under its own name', async () => {
		const p = await portal({ locale: null, displayName: 'Partner portal' })
		const html = await (await p.send(handoffLogin())).text()
		expect(html).toContain('<html lang="en">')
		expect(html).toContain('<h1>Sign in to Partner portal</h1>')
		expect(html).toMatch(/<span class="runs-on">Runs on <svg[^>]*>.*?<\/svg> fabrika<\/span>/)
	})

	test('a stored locale IAM no longer speaks is English', async () => {
		const p = await portal({ locale: 'de', displayName: null })
		const html = await (await p.send(handoffLogin())).text()
		expect(html).toContain('<html lang="en">')
		expect(html).toContain('<h1>Sign in</h1>')
	})

	test('an unknown application is IAM itself: English, no app kept, and the reset ends on the sign-in page of IAM', async () => {
		const p = await portal({ locale: 'cs', displayName: 'Partnerský portál' })
		await partner(p)
		const forgot = await p.send(new Request(`${ISSUER}/auth/forgot-password?app=nowhere%40prod`))
		const forgotHtml = await forgot.text()
		expect(forgotHtml).toContain('<html lang="en">')
		expect(forgotHtml).toContain('action="/auth/forgot-password"')

		await p.send(post('/auth/forgot-password?app=nowhere%40prod', { email: 'partner@example.test' }))
		await p.ctx.settle()
		const mail = lastMail(p.email)
		expect(mail.subject).toBe('Reset your Fabrika password')
		const { url, token } = linkOf(mail)
		expect(url.search).toBe('')
		expect(formAction(await p.send(new Request(url)))).toBe(`'self'`)
		const reset = await p.send(post('/auth/password/reset', { token, password: PASSWORD }))
		expect(reset.headers.get('location')).toBe(`${ISSUER}/auth/login`)
	})

	test('a link naming another application changes words, never where the action lands', async () => {
		const p = await portal({ locale: 'cs', displayName: 'Partnerský portál' })
		await partner(p)
		await p.send(post('/auth/forgot-password', { email: 'partner@example.test' }))
		await p.ctx.settle()
		const { token } = linkOf(lastMail(p.email))
		const reset = await p.send(post(`/auth/password/reset?app=${encodeURIComponent(PORTAL)}`, { token, password: PASSWORD }))
		expect(reset.headers.get('location')).toBe(`${ISSUER}/auth/login`)
	})

	test('an application with a name but no registered origin keeps its words and lands on the sign-in page of IAM', async () => {
		const p = await portal({ locale: 'cs', displayName: 'Partnerský portál' }, [])
		await partner(p)
		await p.send(post(`/auth/forgot-password?app=${encodeURIComponent(PORTAL)}`, { email: 'partner@example.test' }))
		await p.ctx.settle()
		const { url, token } = linkOf(lastMail(p.email))
		expect(lastMail(p.email).subject).toBe('Obnovení hesla pro aplikaci Partnerský portál')
		expect(formAction(await p.send(new Request(url)))).toBe(`'self'`)
		const reset = await p.send(post(`/auth/password/reset?app=${encodeURIComponent(PORTAL)}`, { token, password: PASSWORD }))
		expect(reset.headers.get('location')).toBe(`${ISSUER}/auth/login`)
	})
})

describe('the display name is escaped', () => {
	test('on the pages and in the HTML mail; the plain-text mail carries it as written', async () => {
		const name = '<b>"Q&A"</b>'
		const escaped = '&lt;b&gt;&quot;Q&amp;A&quot;&lt;/b&gt;'
		const p = await portal({ locale: 'en', displayName: name })
		await partner(p)
		const signIn = await (await p.send(handoffLogin())).text()
		expect(signIn).toContain(`<title>Sign in to ${escaped}</title>`)
		expect(signIn).not.toContain(name)
		const forgot = await (await p.send(new Request(`${ISSUER}/auth/forgot-password?app=${encodeURIComponent(PORTAL)}`))).text()
		expect(forgot).toContain(escaped)
		expect(forgot).not.toContain(name)

		await p.send(post(`/auth/forgot-password?app=${encodeURIComponent(PORTAL)}`, { email: 'partner@example.test' }))
		await p.ctx.settle()
		const mail = lastMail(p.email)
		expect(mail.html).toContain(escaped)
		expect(mail.html).not.toContain(name)
		expect(mail.text).toContain(`reset your password for ${name}`)
		const page = await (await p.send(new Request(linkOf(mail).url))).text()
		expect(page).toContain(escaped)
		expect(page).not.toContain(name)
	})
})

describe('an invitation of a cs application', () => {
	async function invited(origins: string[]) {
		const h = createHarness()
		const email = new CapturingEmail()
		const f = await membershipFixture(h.repositories, { email })
		expect((await f.putSchema({ ...NOTES_SCHEMA, locale: 'cs', displayName: 'Poznámky' })).status).toBe(200)
		if (origins.length > 0) await f.services.repositories.handoff.setReturnOrigins(APP, origins)
		const owner = await f.person('owner')
		await f.repositories.grants.createGrant({ principalId: owner.id, app: APP, roleKey: 'starter' })
		const call = async (endpoint: string, requestId: string) => {
			const base = { app: APP, credential: await owner.token(), requestId }
			const grant = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...base, endpoint })
			if (!grant.ok) throw new Error('no delegation')
			return { ...base, delegation: grant.grant }
		}
		const created = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await call(CREATE_ENDPOINT, 'req-create')), dimension: 'workspace' })
		if (!created.ok) throw new Error('no workspace')
		await assignMember(f.services, CALLER_ENV, f.ctx, {
			...(await call(INVITE_ENDPOINT, 'req-invite')),
			scope: created.scope,
			role: 'editor',
			member: { email: 'invitee@example.test' },
		})
		const invitee = await f.person('invitee')
		const cookie = `${SESSION_COOKIE}=${await h.signSession(invitee.id)}`
		const send = (request: Request) => handleAuth(request, f.services, CALLER_ENV, f.ctx)
		return { email, send, cookie, mail: lastMail(email) }
	}

	const accept = (url: URL, token: string, headers: Record<string, string>) =>
		new Request(new URL(`${url.pathname}${url.search}`, ORIGIN), {
			method: 'POST',
			headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
			body: new URLSearchParams({ token }),
		})

	test('the mail and the page are Czech, and the accepted invitation ends in the application', async () => {
		const i = await invited(['https://notes.example.com'])
		expect(i.mail.subject).toBe('Pozvánka do aplikace Poznámky')
		expect(i.mail.text).toStartWith('Dostali jste pozvánku do aplikace Poznámky s rolí Editor (workspace).')
		const { url, token } = linkOf(i.mail)
		expect(`${url.pathname}${url.search}`).toBe('/auth/invitations/accept?app=notes%40prod')

		const page = await i.send(new Request(url))
		const html = await page.text()
		expect(html).toContain('<html lang="cs">')
		expect(html).toContain('<h1>Přijetí pozvánky</h1>')
		expect(html).toContain('action="/auth/invitations/accept?app=notes%40prod"')
		expect(formAction(page)).toBe(`'self' https://notes.example.com`)

		const signInFirst = await i.send(accept(url, token, {}))
		expect(signInFirst.status).toBe(401)
		const signInHtml = await signInFirst.text()
		expect(signInHtml).toContain('Nejprve se přihlaste')
		expect(signInHtml).toContain('href="https://notes.example.com/"')

		const accepted = await i.send(accept(url, token, { Cookie: i.cookie }))
		expect(accepted.status).toBe(302)
		expect(accepted.headers.get('location')).toBe('https://notes.example.com/')
	})

	test('without a registered origin the outcome page is Czech, and signing in first goes through IAM', async () => {
		const i = await invited([])
		const { url, token } = linkOf(i.mail)
		const signInFirst = await (await i.send(accept(url, token, {}))).text()
		expect(signInFirst).toContain(`href="${ORIGIN}/auth/login?redirect=`)
		const accepted = await i.send(accept(url, token, { Cookie: i.cookie }))
		expect(accepted.status).toBe(200)
		const html = await accepted.text()
		expect(html).toContain('Pozvánka přijata')
		expect(html).toContain('V aplikaci Poznámky teď máte roli Editor (workspace).')
	})
})
