import { describe, expect, test } from 'bun:test'
import { iamMailCatalog, iamMessageTemplate, mailLocale, type MessageValues } from '../iam-mail'
import { LOCALES } from '../locale'

const INVITATION: MessageValues['invitation'] = {
	appName: 'Portal',
	role: 'editor',
	scope: 'workspace',
	recipient: 'person@example.test',
	inviterLabel: 'Inviter',
	companyLabel: '',
	message: '',
	actionUrl: 'https://iam.test/auth/invitations/accept?app=portal#token=t',
	expiresAt: 1_900_000_000,
	acceptance: 'sign_in',
}

const rendering = { displayName: 'Portal', appUrl: null, maxSubjectLength: 998 }

describe('mailLocale', () => {
	test("the person's language beats the application's, which beats the default", () => {
		expect(mailLocale({ person: 'uk', app: 'cs' })).toBe('uk')
		expect(mailLocale({ person: null, app: 'cs' })).toBe('cs')
		expect(mailLocale({})).toBe('en')
	})
})

describe('iamMailCatalog', () => {
	test('words each language differently and places the link in both bodies', () => {
		const subjects = LOCALES.map((locale) => iamMailCatalog(locale).messages.invitation(INVITATION).subject)
		expect(new Set(subjects).size).toBe(LOCALES.length)
		for (const locale of LOCALES) {
			const message = iamMailCatalog(locale).messages.invitation(INVITATION)
			expect(message.text).toContain(INVITATION.actionUrl)
			expect(message.html).toContain('https://iam.test/auth/invitations/accept?app=portal#token=t')
		}
		expect(iamMailCatalog('uk').messages.invitation(INVITATION).subject).toBe('Запрошення до застосунку Portal')
	})

	test('escapes every value it puts into HTML', () => {
		const html = iamMailCatalog('en').messages.invitation({ ...INVITATION, role: '<b>', message: 'a & b' }).html
		expect(html).toContain('&lt;b&gt;')
		expect(html).toContain('a &amp; b')
		expect(html).not.toContain('<b>')
	})
})

describe('iamMessageTemplate', () => {
	test("without the application's template it is the catalog's of the e-mail's language", () => {
		const message = iamMessageTemplate('invitation', { ...rendering, locale: 'cs', template: null })(INVITATION)
		expect(message).toEqual(iamMailCatalog('cs').messages.invitation(INVITATION))
	})

	test("fills the application's template, with IAM's button of that language", () => {
		const template = { subject: 'Vítejte v {{displayName}}', text: 'Odkaz: {{actionUrl}}' }
		const message = iamMessageTemplate('invitation', { ...rendering, locale: 'cs', template })(INVITATION)
		expect(message.subject).toBe('Vítejte v Portal')
		expect(message.text).toBe(`Odkaz: ${INVITATION.actionUrl}`)
		expect(message.html).toContain('Přijmout pozvánku')
	})

	test('a refused template, or one naming {{appUrl}} without an address, is the catalog’s', () => {
		const refused = { subject: 'Hello', text: 'no link here' }
		expect(iamMessageTemplate('invitation', { ...rendering, locale: 'en', template: refused })(INVITATION).subject).toBe('You are invited to Portal')
		const appUrl = { subject: 'Hello', text: '{{appUrl}} {{actionUrl}}' }
		expect(iamMessageTemplate('invitation', { ...rendering, locale: 'en', template: appUrl })(INVITATION).subject).toBe('You are invited to Portal')
	})

	test('a filled subject gives way at its end to the sender’s limit', () => {
		const template = { subject: '{{displayName}} invites you', text: '{{actionUrl}}' }
		const message = iamMessageTemplate('invitation', { ...rendering, maxSubjectLength: 10, locale: 'en', template })(INVITATION)
		expect(message.subject).toBe('Portal in…')
	})
})
