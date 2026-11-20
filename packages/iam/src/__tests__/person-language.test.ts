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
import { describe, expect, test } from 'bun:test'
import { appQuery, INSTALLATION_PRESENTATION } from '../app-presentation'
import { handleAuth } from '../auth/routes'
import { assignMember, createScope, requestDelegation } from '../membership'
import { pkceChallenge } from '../oidc'
import type { PasswordHasher, StoredPasswordHash } from '../password-crypto'
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
