// The browser steps the Notes onboarding scenarios share: a person signs in to Notes from IAM's Czech sign-in page, sets
// a password from a one-time link, and is checked to be back in Notes. Every link comes from the captured mail.

import { SESSION_COOKIE } from '@fabrika/auth-core'
import { byRole, expect, getContext, getPage } from '@opice/harness'
import { randomUUID } from 'node:crypto'

export const IAM_URL = process.env['FABRIKA_BROWSER_IAM_ORIGIN'] ?? 'http://iam.fabrika.localhost:18080'
export const NOTES_URL = process.env['FABRIKA_BROWSER_APP_URL'] ?? 'http://notes.fabrika.localhost:18081'

export function newPassword(): string {
	return `notes browser ${randomUUID()}`
}

/** A mailbox no principal holds yet, marked with the scenario that uses it. */
export function newMailbox(prefix: string): string {
	return `${prefix}-${randomUUID()}@local.test`
}

export async function expectOnIam(path: string): Promise<void> {
	await expect.poll(() => {
		const url = new URL(getPage().url())
		return `${url.origin}${url.pathname}`
	}).toBe(`${IAM_URL}${path}`)
}

/** Open Notes in a browser with no session anywhere, and wait for IAM's Czech sign-in page. */
export async function openNotesSignedOut(): Promise<void> {
	await getContext().clearCookies()
	await getPage().goto(`${NOTES_URL}/`)
	await expectOnIam('/auth/login')
	await expect(getPage().locator('html')).toHaveAttribute('lang', 'cs')
	await expect(byRole('heading', 'Přihlášení', { exact: true, level: 1 })).toBeVisible()
}

/** Fill IAM's Czech sign-in form and submit it. */
export async function submitSignIn(email: string, password: string): Promise<void> {
	await getPage().getByLabel('E-mail', { exact: true }).fill(email)
	await getPage().getByLabel('Heslo').fill(password)
	await byRole('button', 'Přihlásit se', { exact: true }).click()
}

/** Start from a browser with no session anywhere, open Notes, and sign in on IAM's Czech sign-in page. */
export async function signInFromNotes(email: string, password: string): Promise<void> {
	await openNotesSignedOut()
	await submitSignIn(email, password)
}

export async function expectSignedInToNotes(): Promise<void> {
	await expect.poll(() => new URL(getPage().url()).origin).toBe(NOTES_URL)
	await expect(byRole('heading', 'Notes', { exact: true, level: 1 })).toBeVisible()
	// The SPA writes the limits only after `notes.list` answered, which the proxy admits only for a signed-in member.
	await expect(getPage().locator('#limits')).toContainText('attachments')
	const cookies = await getContext().cookies(NOTES_URL)
	expect(cookies.some((cookie) => cookie.name === SESSION_COOKIE)).toBe(true)
}

/** The words of one of IAM's set-password pages, in the language it speaks. */
export interface PasswordPage {
	readonly title: string
	readonly label: string
	readonly button: string
}

/** Choose the password on the page a one-time link opened, and submit it. */
export async function choosePassword(page: PasswordPage, password: string): Promise<void> {
	await expect(byRole('heading', page.title, { exact: true, level: 1 })).toBeVisible()
	await getPage().getByLabel(page.label).fill(password)
	await byRole('button', page.button, { exact: true }).click()
}
