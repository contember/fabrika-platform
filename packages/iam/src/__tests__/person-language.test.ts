// A person may read IAM in a language other than their application's. The inviting application names it on the
// invitation (`InvitationOptions.locale`); IAM mails the invitation in it, keeps it as the person's at acceptance, and
// speaks it in their later mail (a password reset) and on the pages those links open. A browser that signed in with it
// keeps it on IAM's sign-in page (`LOCALE_COOKIE`). Without any of that, the application's language holds as before,
// and only where no application declares one does the browser's `Accept-Language` choose.

import {
	type AppSchema,
	AUTH_HANDOFF_CHALLENGE_PARAM,
	AUTH_HANDOFF_STATE_PARAM,
	invitationOptionsProblem,
	type Locale,
	SESSION_COOKIE,
} from '@fabrika/auth-core'
import type { EmailMessage } from '@fabrika/email'
import { createVerifyService } from '@fabrika/proxy-core'
import { describe, expect, test } from 'bun:test'
import { FakeIam, manifestWith, serviceRow, verifyRequest } from '../../../proxy-core/src/__tests__/helpers'
import { appQuery, INSTALLATION_PRESENTATION } from '../app-presentation'
import { handleAuth } from '../auth/routes'
import { assignMember, createScope, requestDelegation } from '../membership'
import { pkceChallenge } from '../oidc'
import type { PasswordHasher, StoredPasswordHash } from '../password-crypto'
import { issuePasswordAction } from '../password-service'
import { browserLocale, chooseLocale, LOCALE_COOKIE } from '../person-locale'
import { hashToken } from '../secret'
import { createHarness, type Harness } from './helpers/harness'
import {
	APP,
	CALLER_ENV,
	CapturingEmail,
	CREATE_ENDPOINT,
	INVITE_ENDPOINT,
	type MembershipFixture,
	membershipFixture,
	ONBOARDING_SCHEMA,
	ORIGIN,
	type Person,
} from './helpers/membership'

const LANDING = 'https://notes.example.com'
const PASSWORD = 'a sufficiently long passphrase'
const INVITEE = 'invitee@example.test'
const NEWCOMER = 'newcomer@partner.test'
const HANDOFF_STATE = 'state-state-state1'
const HANDOFF_CHALLENGE = await pkceChallenge('browser-held-verifier-browser-held-verifier-1')

class PlainHasher implements PasswordHasher {
	async hash(password: string): Promise<StoredPasswordHash> {
		return { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: `hash:${password}` }
	}

	async verify(password: string, stored: StoredPasswordHash) {
		return { valid: stored.passwordHash === `hash:${password}`, needsRehash: false }
	}
}

interface Notes {
	readonly h: Harness
	readonly f: MembershipFixture
	readonly email: CapturingEmail
	readonly owner: Person
	invite(address: string, options?: { role?: string; locale?: Locale; resend?: boolean }): ReturnType<typeof assignMember>
	send(request: Request): Promise<Response>
}

let seq = 0

/** The Notes application, declared Czech unless `vocabulary` says otherwise, with mail, passwords and a landing. */
async function notes(vocabulary: Pick<AppSchema, 'locale' | 'displayName'> = { locale: 'cs', displayName: 'Poznámky' }): Promise<Notes> {
	const h = createHarness()
	const email = new CapturingEmail()
	const f = await membershipFixture(h.repositories, {
		email,
		services: {
			authentication: { oidc: false, password: true },
			passwordHasher: new PlainHasher(),
			human: { emailDomains: ['example.test'], emails: [] },
		},
	})
	expect((await f.putSchema({ ...ONBOARDING_SCHEMA, ...vocabulary })).status).toBe(200)
	await f.repositories.handoff.setReturnOrigins(APP, [LANDING])
	const owner = await f.person('owner')
	await f.repositories.grants.createGrant({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const delegated = async (endpoint: string) => {
		seq += 1
		const base = { app: APP, credential: await owner.token(), requestId: `req-${seq}` }
		const grant = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...base, endpoint })
		if (!grant.ok) throw new Error(`no delegation: ${grant.reason}`)
		return { ...base, delegation: grant.grant }
	}
	const created = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(CREATE_ENDPOINT)), dimension: 'workspace' })
	if (!created.ok) throw new Error('no workspace')
	return {
		h,
		f,
		email,
		owner,
		invite: async (address, { role = 'editor', ...invitation } = {}) =>
			assignMember(f.services, CALLER_ENV, f.ctx, {
				...(await delegated(INVITE_ENDPOINT)),
				scope: created.scope,
				role,
				member: { email: address },
				...(Object.keys(invitation).length === 0 ? {} : { invitation }),
			}),
		send: (request) => handleAuth(request, f.services, CALLER_ENV, f.ctx),
	}
}

/** A person with a password account here, as a staff member who signs in with a password is. */
async function invitee(n: Notes): Promise<Person> {
	const person = await n.f.person('invitee')
	await n.f.repositories.passwords.enableEnrollment(person.id)
	await n.f.repositories.passwords.upsertCredential(person.id, await new PlainHasher().hash('the old long passphrase'))
	return person
}

function lastMail(email: CapturingEmail): EmailMessage {
	const message = email.messages.at(-1)
	if (message === undefined) throw new Error('no mail was sent')
	return message
}

function linkOf(message: EmailMessage): { url: URL; token: string } {
	const link = /https?:\/\/\S+/.exec(message.text)?.[0]
	if (link === undefined) throw new Error('no link in the mail')
	const url = new URL(link)
	const token = new URLSearchParams(url.hash.slice(1)).get('token')
	if (token === null) throw new Error('no token in the link')
	return { url, token }
}

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Request {
	return new Request(new URL(path, ORIGIN), {
		method: 'POST',
		headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
		body: new URLSearchParams(fields),
	})
}

function handoffLogin(headers: Record<string, string> = {}): Request {
	const url = new URL('/auth/login', ORIGIN)
	url.searchParams.set('app', APP)
	url.searchParams.set('redirect', `${LANDING}/`)
	url.searchParams.set(AUTH_HANDOFF_STATE_PARAM, HANDOFF_STATE)
	url.searchParams.set(AUTH_HANDOFF_CHALLENGE_PARAM, HANDOFF_CHALLENGE)
	return new Request(url, { headers })
}

function cookieOf(response: Response, name: string): string | null {
	const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))
	return header === undefined ? null : (header.split(';')[0] ?? null)
}

const lang = async (response: Response): Promise<string | undefined> => /<html lang="([^"]+)">/.exec(await response.text())?.[1]

describe("an invitation that names the person's language", () => {
	test("is mailed in it, its page speaks it, and accepting keeps it as the person's", async () => {
		const n = await notes()
		const person = await invitee(n)
		expect(await n.invite(INVITEE, { locale: 'uk' })).toMatchObject({ ok: true })

		const mail = lastMail(n.email)
		expect(mail.subject).toBe('Запрошення до застосунку Poznámky')
		expect(mail.text).toStartWith('Вас запрошено до застосунку Poznámky з роллю Editor (workspace).')
		const { url, token } = linkOf(mail)
		expect(`${url.pathname}${url.search}`).toBe('/auth/invitations/accept?app=notes%40prod&locale=uk')

		const page = await n.send(new Request(url))
		const html = await page.text()
		expect(html).toContain('<html lang="uk">')
		expect(html).toContain('<h1>Прийняття запрошення</h1>')
		expect(html).toContain('action="/auth/invitations/accept?app=notes%40prod&amp;locale=uk"')

		const cookie = `${SESSION_COOKIE}=${await n.h.signSession(person.id, { authenticationMethod: 'password', idpSub: null })}`
		const accepted = await n.send(post(`${url.pathname}${url.search}`, { token }, { Cookie: cookie }))
		expect(accepted.status).toBe(302)
		expect((await n.f.repositories.principals.getPrincipalById(person.id))?.locale).toBe('uk')
	})

	test('an acceptance whose language cannot be written still accepts', async () => {
		const n = await notes()
		const person = await invitee(n)
		await n.invite(INVITEE, { locale: 'uk' })
		const { url, token } = linkOf(lastMail(n.email))
		const principals = n.f.repositories.principals
		const setLocale = principals.setLocale
		principals.setLocale = () => Promise.reject(new Error('locale write refused'))
		try {
			const cookie = `${SESSION_COOKIE}=${await n.h.signSession(person.id, { authenticationMethod: 'password', idpSub: null })}`
			const accepted = await n.send(post(`${url.pathname}${url.search}`, { token }, { Cookie: cookie }))
			expect(accepted.status).toBe(302)
		} finally {
			principals.setLocale = setLocale
		}
		expect((await principals.getPrincipalById(person.id))?.locale).toBeNull()
	})

	test("the person's later reset is Ukrainian in a Czech application, and the browser keeps the language", async () => {
		const n = await notes()
		const person = await invitee(n)
		await n.f.repositories.principals.setLocale(person.id, 'uk')

		// The forgot-password page names no person yet, so it speaks the application's language.
		expect(await lang(await n.send(new Request(`${ORIGIN}/auth/forgot-password?app=${encodeURIComponent(APP)}`)))).toBe('cs')
		await n.send(post(`/auth/forgot-password?app=${encodeURIComponent(APP)}`, { email: INVITEE }))
		await n.f.ctx.settle()

		const mail = lastMail(n.email)
		expect(mail.subject).toBe('Відновлення пароля для застосунку Poznámky')
		const { url, token } = linkOf(mail)
		expect(`${url.pathname}${url.search}`).toBe('/auth/password/reset?app=notes%40prod&locale=uk')
		expect((await n.f.repositories.passwords.inspectActionToken(await hashToken(token), 'reset'))?.locale).toBe('uk')

		const page = await n.send(new Request(url))
		const html = await page.text()
		expect(html).toContain('<html lang="uk">')
		expect(html).toContain('<h1>Відновіть пароль</h1>')

		// A refused password is answered in the action's language, whatever the form's query said.
		const weak = await n.send(post('/auth/password/reset?app=notes%40prod', { token, password: 'short' }))
		expect(await weak.text()).toContain('Пароль має містити щонайменше 15 символів.')

		const reset = await n.send(post(`${url.pathname}${url.search}`, { token, password: PASSWORD }))
		expect(reset.status).toBe(302)
		expect(cookieOf(reset, LOCALE_COOKIE)).toBe(`${LOCALE_COOKIE}=uk`)
		expect(reset.headers.getSetCookie().find((cookie) => cookie.startsWith(`${LOCALE_COOKIE}=`))).toContain('HttpOnly; Secure; SameSite=Lax')

		const signIn = await n.send(handoffLogin({ Cookie: `${LOCALE_COOKIE}=uk` }))
		const signInHtml = await signIn.text()
		expect(signInHtml).toContain('<html lang="uk">')
		expect(signInHtml).toContain('<h1>Вхід до застосунку Poznámky</h1>')
		expect(await lang(await n.send(handoffLogin()))).toBe('cs')
	})

	test("an administrator's password action is mailed in the person's language, else IAM's default", async () => {
		const n = await notes()
		const person = await invitee(n)
		const issue = async () => {
			const principal = await n.f.repositories.principals.getPrincipalById(person.id)
			if (principal === null) throw new Error('no principal')
			const audit = {
				requestId: 'req-admin',
				principalId: n.owner.id,
				principalLabel: 'owner',
				app: 'propustka',
				action: 'iam.password.reset.issue',
				resourceType: 'principal',
			}
			return issuePasswordAction(n.f.services, { principal, purpose: 'reset', issuedBy: n.owner.id, presentation: INSTALLATION_PRESENTATION }, {
				audit,
				enableEnrollment: false,
			})
		}
		expect((await issue()).message?.subject).toBe('Reset your Fabrika password')
		await n.f.repositories.principals.setLocale(person.id, 'uk')
		const action = await issue()
		expect(action.message?.subject).toBe('Відновлення пароля')
		expect(new URL(action.url).search).toBe('?locale=uk')
		expect(await lang(await n.send(new Request(action.url)))).toBe('uk')
	})

	test('a sign-in of a person without a language clears the one a previous person left on the browser', async () => {
		const n = await notes()
		await invitee(n)
		const reset = async (headers: Record<string, string>) => {
			await n.send(post(`/auth/forgot-password?app=${encodeURIComponent(APP)}`, { email: INVITEE }))
			await n.f.ctx.settle()
			const { url, token } = linkOf(lastMail(n.email))
			expect(`${url.pathname}${url.search}`).toBe('/auth/password/reset?app=notes%40prod')
			const response = await n.send(post(`${url.pathname}${url.search}`, { token, password: PASSWORD }, headers))
			expect(response.status).toBe(302)
			return response
		}
		const shared = await reset({ Cookie: `${LOCALE_COOKIE}=uk` })
		expect(cookieOf(shared, LOCALE_COOKIE)).toBe(`${LOCALE_COOKIE}=`)
		expect(shared.headers.getSetCookie().find((cookie) => cookie.startsWith(`${LOCALE_COOKIE}=`))).toContain('Max-Age=0')
		expect(cookieOf(await reset({}), LOCALE_COOKIE)).toBeNull()
	})

	test('an invitation that names none speaks the language the invited person already has', async () => {
		const n = await notes()
		const person = await invitee(n)
		await n.f.repositories.principals.setLocale(person.id, 'uk')
		await n.invite(INVITEE)
		expect(lastMail(n.email).subject).toBe('Запрошення до застосунку Poznámky')
		expect((await n.f.repositories.principals.getPrincipalById(person.id))?.locale).toBe('uk')
	})

	test('without a language anywhere, the invitation and its acceptance follow the application as before', async () => {
		const n = await notes()
		const person = await invitee(n)
		await n.invite(INVITEE)
		const mail = lastMail(n.email)
		expect(mail.subject).toBe('Pozvánka do aplikace Poznámky')
		const { url, token } = linkOf(mail)
		expect(`${url.pathname}${url.search}`).toBe('/auth/invitations/accept?app=notes%40prod')
		const cookie = `${SESSION_COOKIE}=${await n.h.signSession(person.id, { authenticationMethod: 'password', idpSub: null })}`
		expect((await n.send(post(`${url.pathname}${url.search}`, { token }, { Cookie: cookie }))).status).toBe(302)
		expect((await n.f.repositories.principals.getPrincipalById(person.id))?.locale).toBeNull()
	})

	test('a new external person chooses the password in it, and their account keeps it', async () => {
		const n = await notes()
		await n.invite(NEWCOMER, { role: 'partner', locale: 'uk' })
		const mail = lastMail(n.email)
		expect(mail.text).toContain('ви створите пароль')
		const { url, token } = linkOf(mail)

		const form = await n.send(post(`${url.pathname}${url.search}`, { token }))
		const html = await form.text()
		expect(html).toContain('<html lang="uk">')
		expect(html).toContain('<h1>Створіть пароль</h1>')

		const created = await n.send(post(`${url.pathname}${url.search}`, { token, password: PASSWORD }))
		expect(created.status).toBe(302)
		expect((await n.f.repositories.principals.getUserByEmail(NEWCOMER))?.locale).toBe('uk')
		expect(cookieOf(created, LOCALE_COOKIE)).toBe(`${LOCALE_COOKIE}=uk`)
	})

	test('a resend that names a language replaces it; one that names none keeps it', async () => {
		const n = await notes()
		await n.invite(INVITEE, { locale: 'uk' })
		await n.invite(INVITEE, { resend: true, locale: 'en' })
		expect(lastMail(n.email).subject).toBe('You are invited to Poznámky')
		await n.invite(INVITEE, { resend: true })
		expect(lastMail(n.email).subject).toBe('You are invited to Poznámky')
		expect(n.email.messages).toHaveLength(3)
	})

	test('a language IAM does not speak is refused before anything is written', async () => {
		const unknown: Locale = JSON.parse('"de"')
		expect(invitationOptionsProblem({ locale: unknown })).toBe("an invitation locale is one of 'en', 'cs', 'uk'")
		const n = await notes()
		expect(await n.invite(INVITEE, { locale: unknown })).toEqual({
			ok: false,
			reason: 'invalid_request',
			message: "an invitation locale is one of 'en', 'cs', 'uk'",
		})
		expect(n.email.messages).toHaveLength(0)
	})
})

describe('every page a person invited in their language reaches', () => {
	/** The invitation link's path and query, and its token: the person's language rides the query (`&locale=uk`). */
	async function invited(n: Notes, address = INVITEE, role = 'editor') {
		await n.invite(address, { role, locale: 'uk' })
		const { url, token } = linkOf(lastMail(n.email))
		return { path: `${url.pathname}${url.search}`, token }
	}
	const sessionOf = async (n: Notes, person: Person) =>
		`${SESSION_COOKIE}=${await n.h.signSession(person.id, { authenticationMethod: 'password', idpSub: null })}`

	test('a used, an expired and a mistyped link are refused in it', async () => {
		const n = await notes()
		const person = await invitee(n)
		const { path, token } = await invited(n)
		const cookie = await sessionOf(n, person)
		expect((await n.send(post(path, { token }, { Cookie: cookie }))).status).toBe(302)
		const used = await n.send(post(path, { token }, { Cookie: cookie }))
		expect(used.status).toBe(400)
		const usedHtml = await used.text()
		expect(usedHtml).toContain('<html lang="uk">')
		expect(usedHtml).toContain('<h1>Посилання недоступне</h1>')

		const again = await invited(n, 'another@example.test')
		n.h.sqlite.run('UPDATE membership_invitations SET expires_at = 1 WHERE accepted_at IS NULL')
		expect(await lang(await n.send(post(again.path, { token: again.token })))).toBe('uk')
		expect(await lang(await n.send(post(again.path, { token: 'not a token' })))).toBe('uk')
	})

	test('a browser signed in as someone else, or not signed in, is answered in it', async () => {
		const n = await notes()
		await invitee(n)
		const { path, token } = await invited(n)
		const wrong = await n.send(post(path, { token }, { Cookie: await sessionOf(n, n.owner) }))
		expect(wrong.status).toBe(403)
		expect(await wrong.text()).toContain('<h1>Запрошення для іншої адреси</h1>')

		const signInFirst = await n.send(post(path, { token }))
		expect(signInFirst.status).toBe(401)
		const html = await signInFirst.text()
		expect(html).toContain('<html lang="uk">')
		expect(html).toContain('<h1>Спочатку увійдіть</h1>')

		const external = await invited(n, NEWCOMER, 'partner')
		const other = await n.send(post(external.path, { token: external.token }, { Cookie: await sessionOf(n, n.owner) }))
		expect(other.status).toBe(409)
		expect(await other.text()).toContain('<h1>Ви ввійшли з іншим обліковим записом</h1>')
	})

	test('its "sign in first" remembers the language for the sign-in the application\'s proxy starts', async () => {
		const n = await notes()
		await invitee(n)
		const { path, token } = await invited(n)
		const signInFirst = await n.send(post(path, { token }))
		expect(signInFirst.status).toBe(401)
		expect(await signInFirst.text()).toContain(`href="${LANDING}/"`)
		expect(cookieOf(signInFirst, LOCALE_COOKIE)).toBe(`${LOCALE_COOKIE}=uk`)
		expect(signInFirst.headers.getSetCookie().find((cookie) => cookie.startsWith(`${LOCALE_COOKIE}=`))).toContain('HttpOnly; Secure; SameSite=Lax')
		// The application's address bounces the browser to a sign-in without `?locale=`; the cookie makes it speak Ukrainian.
		const signIn = await n.send(handoffLogin({ Cookie: `${LOCALE_COOKIE}=uk` }))
		expect(await signIn.text()).toContain('<h1>Вхід до застосунку Poznámky</h1>')

		// The invitation's own language counts even when the form's query lost the link's `?locale=`.
		const unhinted = await n.send(post(path.replace('&locale=uk', ''), { token }))
		expect(unhinted.status).toBe(401)
		expect(cookieOf(unhinted, LOCALE_COOKIE)).toBe(`${LOCALE_COOKIE}=uk`)
	})

	test('a "sign in first" of an invitation that names no language remembers none', async () => {
		const n = await notes()
		await invitee(n)
		await n.invite(INVITEE)
		const { url, token } = linkOf(lastMail(n.email))
		const signInFirst = await n.send(post(`${url.pathname}${url.search}`, { token }))
		expect(signInFirst.status).toBe(401)
		expect(await lang(signInFirst)).toBe('cs')
		expect(cookieOf(signInFirst, LOCALE_COOKIE)).toBeNull()
	})

	test("the proxy's bounce with the application host's language speaks it, and the form keeps the handoff", async () => {
		const n = await notes()
		const bounced = handoffLogin()
		const url = new URL(bounced.url)
		url.searchParams.set('locale', 'uk')
		const page = await n.send(new Request(url))
		expect(page.status).toBe(200)
		const html = await page.text()
		expect(html).toContain('<html lang="uk">')
		expect(html).toContain('action="/auth/login?locale=uk"')
		expect(html).toContain(`name="state" value="${HANDOFF_STATE}"`)
		expect(html).toContain(`name="code_challenge" value="${HANDOFF_CHALLENGE}"`)
		expect(await lang(await n.send(handoffLogin()))).toBe('cs')
	})

	test("IAM's sign-in reached with the language keeps it through a refused password and its links", async () => {
		const n = await notes()
		await invitee(n)
		const page = await n.send(new Request(`${ORIGIN}/auth/login?locale=uk`))
		const html = await page.text()
		expect(html).toContain('<html lang="uk">')
		expect(html).toContain('action="/auth/login?locale=uk"')
		expect(html).toContain('href="/auth/forgot-password?locale=uk"')

		const refused = await n.send(post('/auth/login?locale=uk', { email: INVITEE, password: 'not the passphrase at all' }))
		expect(refused.status).toBe(401)
		expect(await refused.text()).toContain('Неправильна електронна адреса або пароль.')

		// The recovery page's way back is the sign-in in the same language.
		const sent = await n.send(post('/auth/forgot-password?locale=uk', { email: INVITEE }))
		await n.f.ctx.settle()
		expect(await sent.text()).toContain('href="/auth/login?locale=uk"')
	})

	test("the account question speaks the signed-in person's own language, and its answer keeps it", async () => {
		const n = await notes()
		const person = await invitee(n)
		await n.f.repositories.principals.setLocale(person.id, 'uk')
		const cookie = await sessionOf(n, person)
		// A login older than a minute that holds no session at the app is asked before it is used.
		n.h.sqlite.run('UPDATE sessions SET created_at = created_at - 3600 WHERE principal_id = ?', [person.id])
		const question = await n.send(handoffLogin({ Cookie: cookie }))
		expect(question.status).toBe(200)
		const html = await question.text()
		expect(html).toContain('<html lang="uk">')
		expect(html).toContain('<h1>Перехід до застосунку Poznámky</h1>')
		expect(html).toContain('action="/auth/login/account?locale=uk"')
		const malformed = await n.send(post('/auth/login/account?locale=uk', { decision: 'neither' }, { Cookie: cookie }))
		expect(await lang(malformed)).toBe('uk')
	})

	test("a terminal completion's refusal follows the browser", async () => {
		const n = await notes()
		const refused = await n.send(
			new Request(`${ORIGIN}/auth/terminals/complete?identification=unknown`, { headers: { 'Accept-Language': 'uk-UA' } }),
		)
		expect(refused.status).toBe(403)
		expect(await lang(refused)).toBe('uk')
	})
})

describe("the application's proxy and IAM, end to end", () => {
	// proxy-core's real verify service for the application's address, in front of the same IAM `handleAuth` serves.
	const proxy = () =>
		createVerifyService({
			manifest: manifestWith([serviceRow('/*', ['human'])], { id: APP, hosts: [new URL(LANDING).host] }),
			iam: new FakeIam({}),
			issuer: ORIGIN,
			cache: null,
		})
	/** The browser opening the application's address: the proxy's bounce, as the request IAM receives. */
	async function bounce(appCookie?: string, iamCookie?: string): Promise<Request> {
		const answer = await proxy()(verifyRequest({ app: APP, path: '/', host: new URL(LANDING).host, cookie: appCookie }))
		expect(answer.status).toBe(302)
		const location = answer.headers.get('location')
		if (location === null) throw new Error('no bounce')
		return new Request(location, iamCookie === undefined ? {} : { headers: { Cookie: iamCookie } })
	}
	const hiddenFields = (html: string) =>
		Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]?.replaceAll('&amp;', '&')]))

	test('an invitation\'s "sign in first" reaches a sign-in in its language, which then signs the browser in to the application', async () => {
		const n = await notes()
		await invitee(n)
		await n.invite(INVITEE, { locale: 'uk' })
		const { url, token } = linkOf(lastMail(n.email))
		const invitation = `${url.pathname}${url.search}`
		const signInFirst = await n.send(post(invitation, { token }))
		expect(await signInFirst.text()).toContain(`href="${LANDING}/"`)
		const remembered = cookieOf(signInFirst, LOCALE_COOKIE)
		expect(remembered).toBe(`${LOCALE_COOKIE}=uk`)

		// The browser follows the link to the application's address; its proxy bounces it to IAM with no `?locale=`.
		const bounced = await bounce(undefined, remembered ?? undefined)
		expect(new URL(bounced.url).searchParams.has('locale')).toBe(false)
		const page = await n.send(bounced)
		const html = await page.text()
		expect(html).toContain('<html lang="uk">')
		expect(html).toContain('<h1>Вхід до застосунку Poznámky</h1>')

		// The page's form carries the proxy's handoff, and signing in returns the browser to the application.
		const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1]
		if (action === undefined) throw new Error('no sign-in form')
		const fields = hiddenFields(html)
		expect(fields.state).toBe(new URL(bounced.url).searchParams.get('state') ?? '')
		const signedIn = await n.send(
			post(action, { ...fields, email: INVITEE, password: 'the old long passphrase' }, { Cookie: remembered ?? '' }),
		)
		expect(signedIn.status).toBe(302)
		expect(signedIn.headers.get('location')?.startsWith(`${LANDING}/`)).toBe(true)
		// The person has no language of their own until they accept, so the sign-in clears the cookie as any such
		// sign-in does; the invitation link they open again carries the invitation's.
		expect(cookieOf(signedIn, LOCALE_COOKIE)).toBe(`${LOCALE_COOKIE}=`)
		expect(await lang(await n.send(new Request(new URL(invitation, ORIGIN))))).toBe('uk')
		const session = cookieOf(signedIn, SESSION_COOKIE)
		if (session === null) throw new Error('no session')
		expect((await n.send(post(invitation, { token }, { Cookie: session }))).status).toBe(302)

		// Accepting kept the language as the person's: their next sign-in through the proxy remembers it again.
		const again = await n.send(await bounce())
		const againHtml = await again.text()
		const againAction = /<form method="post" action="([^"]+)"/.exec(againHtml)?.[1] ?? ''
		const next = await n.send(post(againAction, { ...hiddenFields(againHtml), email: INVITEE, password: 'the old long passphrase' }))
		expect(next.status).toBe(302)
		expect(cookieOf(next, LOCALE_COOKIE)).toBe(`${LOCALE_COOKIE}=uk`)
	})

	test("the language the application left on its own host reaches IAM's sign-in through its proxy", async () => {
		const n = await notes()
		const bounced = await bounce(`theme=dark; ${LOCALE_COOKIE}=uk`)
		expect(new URL(bounced.url).searchParams.get('locale')).toBe('uk')
		expect(await lang(await n.send(bounced))).toBe('uk')
		expect(await lang(await n.send(await bounce('theme=dark')))).toBe('cs')
		expect(await lang(await n.send(await bounce(`${LOCALE_COOKIE}=de`)))).toBe('cs')
	})
})

describe("the browser's language", () => {
	const UKRAINIAN_BROWSER = { 'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8' }

	test('chooses where the application declares no language', async () => {
		const n = await notes({ displayName: 'Notes' })
		const signIn = await n.send(handoffLogin(UKRAINIAN_BROWSER))
		const html = await signIn.text()
		expect(html).toContain('<html lang="uk">')
		expect(html).toContain('<h1>Вхід до застосунку Notes</h1>')
		expect(await lang(await n.send(handoffLogin()))).toBe('en')
	})

	test('never overrides the language an application declares', async () => {
		const n = await notes()
		expect(await lang(await n.send(handoffLogin(UKRAINIAN_BROWSER)))).toBe('cs')
	})

	test("chooses IAM's own pages, and a link's ?locale= beats it", async () => {
		const n = await notes()
		expect(await lang(await n.send(new Request(`${ORIGIN}/auth/forgot-password`, { headers: { 'Accept-Language': 'cs' } })))).toBe('cs')
		expect(await lang(await n.send(new Request(`${ORIGIN}/auth/forgot-password`)))).toBe('en')
		expect(await lang(await n.send(new Request(`${ORIGIN}/auth/forgot-password?app=notes%40prod&locale=uk`)))).toBe('uk')
		// A value IAM does not speak names nothing.
		expect(await lang(await n.send(new Request(`${ORIGIN}/auth/forgot-password?app=notes%40prod&locale=de`)))).toBe('cs')
		expect(await lang(await n.send(new Request(`${ORIGIN}/auth/logout`, { headers: UKRAINIAN_BROWSER })))).toBe('uk')
		// Terminal enrolment names no application either: its refusal follows the browser too.
		const session = `${SESSION_COOKIE}=${await n.h.signSession(n.owner.id, { authenticationMethod: 'password', idpSub: null })}`
		const refused = await n.send(new Request(`${ORIGIN}/auth/terminals/enroll`, { headers: { ...UKRAINIAN_BROWSER, Cookie: session } }))
		expect(refused.status).toBe(403)
		expect(await lang(refused)).toBe('uk')
	})
})

describe('locale selection', () => {
	test('Accept-Language picks the best language IAM speaks by weight, then by order', () => {
		expect(browserLocale(null)).toBeNull()
		expect(browserLocale('')).toBeNull()
		expect(browserLocale('uk-UA,uk;q=0.9,en;q=0.8')).toBe('uk')
		expect(browserLocale('de-DE,de;q=0.9,cs;q=0.5,en;q=0.4')).toBe('cs')
		expect(browserLocale('en;q=0.5, UK;q=0.8')).toBe('uk')
		expect(browserLocale('cs, en')).toBe('cs')
		expect(browserLocale('uk;q=0, en;q=0.1')).toBe('en')
		expect(browserLocale('*, de')).toBeNull()
		expect(browserLocale('uk;q=high, cs;q=0.2')).toBe('cs')
	})

	test('the person beats a hint, the remembered language, the application and the browser, in that order', () => {
		expect(chooseLocale({})).toBe('en')
		expect(chooseLocale({ browser: 'cs' })).toBe('cs')
		expect(chooseLocale({ app: 'cs', browser: 'uk' })).toBe('cs')
		expect(chooseLocale({ remembered: 'uk', app: 'cs', browser: 'en' })).toBe('uk')
		expect(chooseLocale({ hint: 'en', remembered: 'uk', app: 'cs' })).toBe('en')
		expect(chooseLocale({ person: 'uk', hint: 'en', remembered: 'cs', app: 'cs', browser: 'en' })).toBe('uk')
	})

	test("a link carries the person's language only when it is known", () => {
		expect(appQuery(INSTALLATION_PRESENTATION)).toBe('')
		expect(appQuery({ ...INSTALLATION_PRESENTATION, app: APP })).toBe('?app=notes%40prod')
		expect(appQuery({ ...INSTALLATION_PRESENTATION, app: APP, personLocale: 'uk', locale: 'uk' })).toBe('?app=notes%40prod&locale=uk')
		expect(appQuery({ ...INSTALLATION_PRESENTATION, personLocale: 'uk', locale: 'uk' })).toBe('?locale=uk')
	})
})
