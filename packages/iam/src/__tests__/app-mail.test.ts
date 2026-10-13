// An application's wording of IAM's e-mails (`mail` in its contract): IAM fills the subject and the text, builds the HTML
// part itself, and falls back to its catalog where the application declares nothing for the message's language.

import type { MailTemplates } from '@fabrika/auth-core'
import type { EmailMessage } from '@fabrika/email'
import { describe, expect, test } from 'bun:test'
import { handleAuth } from '../auth/routes'
import { messageTemplateFor } from '../messages'
import type { PasswordHasher, StoredPasswordHash } from '../password-crypto'
import { createHarness, seedUser } from './helpers/harness'
import { CapturingEmail, membershipFixture, NOTES_SCHEMA, PendingWork } from './helpers/membership'

const ISSUER = 'https://iam.test'
const PORTAL = 'portal@prod'
const AUTH_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'stage' }

const CS_RESET: MailTemplates = {
	reset: {
		cs: {
			subject: 'Nové heslo do aplikace {{displayName}}',
			text: 'Dobrý den,\n\nnové heslo pro {{recipient}} si nastavíte zde:\n{{actionUrl}}\n\nOdkaz platí do {{expiry}}.',
		},
	},
}

class PlainHasher implements PasswordHasher {
	async hash(password: string): Promise<StoredPasswordHash> {
		return { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: `hash:${password}` }
	}

	async verify(password: string, stored: StoredPasswordHash) {
		return { valid: stored.passwordHash === `hash:${password}`, needsRehash: false }
	}
}

/** The reset mail a partner of the portal receives, the portal reconciled with `locale` and `mail`. */
async function resetMail(locale: string, mail: MailTemplates | undefined): Promise<EmailMessage> {
	const h = createHarness()
	const email = new CapturingEmail()
	const services = h.makeServices({
		issuer: ISSUER,
		environment: 'stage',
		authentication: { oidc: false, password: true },
		passwordHasher: new PlainHasher(),
		email,
	})
	await services.repositories.appSchema.reconcileAppSchema({
		app: PORTAL,
		scopes: [],
		actions: [{ action: 'portal.read' }],
		roles: [],
		presentation: { locale, displayName: 'Partnerský portál' },
		mail: Object.entries(mail ?? {}).flatMap(([kind, byLocale]) =>
			Object.entries(byLocale ?? {}).flatMap((
				[templateLocale, template],
			) => (template === undefined ? [] : [{ kind, locale: templateLocale, ...template }]))
		),
	})
	await services.repositories.handoff.setReturnOrigins(PORTAL, ['https://portal.test'])
	const id = seedUser(h.sqlite, { sub: null, email: 'partner@example.test' })
	await services.repositories.passwords.enableEnrollment(id)
	await services.repositories.passwords.upsertCredential(id, await new PlainHasher().hash('the old long passphrase'))
	const ctx = new PendingWork()
	await handleAuth(
		new Request(`${ISSUER}/auth/forgot-password?app=${encodeURIComponent(PORTAL)}`, {
			method: 'POST',
			headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ email: 'partner@example.test' }),
		}),
		services,
		AUTH_ENV,
		ctx,
	)
	await ctx.settle()
	const message = email.messages.at(-1)
	if (message === undefined) throw new Error('no mail was sent')
	return message
}

describe("an application's e-mail template", () => {
	test("a cs application's reset mail is its template, filled, with IAM's HTML part and button", async () => {
		const mail = await resetMail('cs', CS_RESET)
		expect(mail.subject).toBe('Nové heslo do aplikace Partnerský portál')
		const link = /https:\/\/iam\.test\/auth\/password\/reset\?app=portal%40prod#token=\S+/.exec(mail.text)?.[0] ?? ''
		expect(link).not.toBe('')
		expect(mail.text).toMatch(
			/^Dobrý den,\n\nnové heslo pro partner@example\.test si nastavíte zde:\nhttps:\/\/iam\.test\/\S+\n\nOdkaz platí do \d+\. \S+ \d{4} v \d+:\d\d UTC\.$/,
		)
		expect(mail.html).toBe(
			`<p>Dobrý den,</p><p>nové heslo pro partner@example.test si nastavíte zde:<br>${link}</p>`
				+ `<p>Odkaz platí do ${/platí do (.*)\.$/.exec(mail.text)?.[1]}.</p><p><a href="${link}">Obnovit heslo</a></p>`,
		)
	})

	test("without a template for the message's language, the mail is IAM's catalog", async () => {
		const none = await resetMail('cs', undefined)
		expect(none.subject).toBe('Obnovení hesla pro aplikaci Partnerský portál')
		const english = await resetMail('en', CS_RESET)
		expect(english.subject).toBe('Reset your password for Partnerský portál')
	})

	test('every value is escaped in the HTML part and written as is in the text', async () => {
		const h = createHarness()
		const services = h.makeServices({ issuer: ISSUER, environment: 'stage', authentication: { oidc: false, password: true } })
		await services.repositories.appSchema.reconcileAppSchema({
			app: PORTAL,
			scopes: [],
			actions: [],
			roles: [],
			presentation: { locale: 'en', displayName: '<b>Q&A</b>' },
			mail: [{
				kind: 'invitation',
				locale: 'en',
				subject: '{{inviterLabel}} invites you to {{displayName}}',
				text: '{{displayName}} for {{companyLabel}}\n\n{{message}}\n\n{{actionUrl}}',
			}],
		})
		const render = await messageTemplateFor(services, { app: PORTAL, locale: 'en', displayName: '<b>Q&A</b>', landing: null }, 'invitation')
		const rendered = render({
			appName: '<b>Q&A</b>',
			role: 'Partner',
			scope: 'company',
			recipient: 'partner@example.test',
			inviterLabel: 'Eve\r\nBcc: x@example.test',
			companyLabel: '<i>"ACME"</i>',
			message: "<script>alert('x')</script>\nsee you",
			actionUrl: 'https://iam.test/auth/invitations/accept?app=portal%40prod&x=1#token=t',
			expiresAt: 0,
		})
		expect(rendered.subject).toBe('Eve Bcc: x@example.test invites you to <b>Q&A</b>')
		expect(rendered.text).toBe(
			'<b>Q&A</b> for <i>"ACME"</i>\n\n<script>alert(\'x\')</script>\nsee you\n\nhttps://iam.test/auth/invitations/accept?app=portal%40prod&x=1#token=t',
		)
		const url = 'https://iam.test/auth/invitations/accept?app=portal%40prod&amp;x=1#token=t'
		expect(rendered.html).toBe(
			'<p>&lt;b&gt;Q&amp;A&lt;/b&gt; for &lt;i&gt;&quot;ACME&quot;&lt;/i&gt;</p>'
				+ '<p>&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;<br>see you</p>'
				+ `<p>${url}</p><p><a href="${url}">Accept the invitation</a></p>`,
		)
	})

	test('the reconcile refuses an unknown placeholder and a text without {{actionUrl}}', async () => {
		const f = await membershipFixture(createHarness().repositories)
		const refused = await f.putSchema({
			...NOTES_SCHEMA,
			mail: { invitation: { en: { subject: 'Join {{appName}}', text: 'Join us.' } } },
		})
		expect(refused.status).toBe(400)
		const body = await refused.text()
		expect(body).toContain('mail.invitation.en: the subject names {{appName}}, which the invitation message does not fill')
		expect(body).not.toContain('Join us.')
		const missing = await f.putSchema({ ...NOTES_SCHEMA, mail: { reset: { cs: { subject: 'Heslo', text: 'Bez odkazu.' } } } })
		expect(missing.status).toBe(400)
		expect(await missing.text()).toContain('mail.reset.cs: the text has no {{actionUrl}}')
		expect((await f.putSchema({ ...NOTES_SCHEMA, mail: CS_RESET })).status).toBe(200)
	})
})
