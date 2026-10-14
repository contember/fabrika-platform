import { SESSION_COOKIE } from '@fabrika/auth-core'
import { createPasswordPerson, issuePasswordLink, type PasswordPerson } from '@fabrika/local-stack/browser-support'
import { browserTest, expect, getContext, getPage, invariant, step } from '@opice/harness'
import { choosePassword, expectOnIam, expectSignedInToNotes, IAM_URL, newMailbox, newPassword, NOTES_URL, signInFromNotes } from './support/notes'

/** Open a one-time link, choose the password, and wait for IAM's answer. */
async function setPasswordFromLink(link: string, title: string, password: string): Promise<void> {
	await getPage().goto(link)
	await choosePassword({ title, label: 'New password', button: title }, password)
	// An administrator's action keeps no application, so it lands on IAM's own origin, signed in there.
	await expect.poll(() => new URL(getPage().url()).origin).toBe(IAM_URL)
}

browserTest(
	{
		name: 'A Notes reader sets a password, signs in from Notes in Czech, and resets it',
		url: `${NOTES_URL}/`,
		feature: 'iam-password-onboarding',
		seeds: ['local-stack'],
		roles: ['anonymous'],
		tier: 'standard',
	},
	async () => {
		let person: PasswordPerson | undefined
		const firstPassword = newPassword()
		const secondPassword = newPassword()

		function createdPerson(): PasswordPerson {
			if (person === undefined) throw new Error('the person was not created')
			return person
		}

		await step('an administrator creates a Notes reader with no password', {
			intent: 'the person exists in IAM with a Notes role and nothing to sign in with yet',
			manual: 'In the console, invite a user and grant the Notes reader role.',
		}, async () => {
			person = await createPasswordPerson(newMailbox('notes-password'))
		})

		await step('the person sets a password from an enrollment link', {
			intent: 'IAM mails the link an administrator issued, and the set-password page works in a real browser',
			manual: 'Choose "Enable password" for the user. Open the link in the e-mail, enter a new password, and choose "Set your password".',
		}, async () => {
			await setPasswordFromLink(await issuePasswordLink(createdPerson(), 'enrollment'), 'Set your password', firstPassword)
		})

		await step('the person signs in from Notes in Czech and lands back in Notes', {
			intent: "the proxy sends an anonymous browser to IAM in the application's language, and the password sign-in hands it back to Notes",
			manual: 'In a private browser, open Notes. Verify that the sign-in page is in Czech. Sign in with the password. Verify that Notes opens.',
		}, async () => {
			await signInFromNotes(createdPerson().email, firstPassword)
			await expectSignedInToNotes()
		})

		await step('an administrator issues a reset link and the person sets a new password', {
			intent: 'the reset link replaces the password through the same browser flow',
			manual: 'In the console, choose "Send reset" for the user. Open the link in the e-mail and set a new password.',
		}, async () => {
			await setPasswordFromLink(await issuePasswordLink(createdPerson(), 'reset'), 'Reset your password', secondPassword)
		})

		await step('the new password signs the person in to Notes again', {
			intent: 'after the reset the person is back in the application with the new password',
			manual: 'In a private browser, open Notes and sign in with the new password. Verify that Notes opens.',
		}, async () => {
			await signInFromNotes(createdPerson().email, secondPassword)
			await expectSignedInToNotes()
		})

		await invariant('the replaced password no longer signs in', async () => {
			await signInFromNotes(createdPerson().email, firstPassword)
			await expect(getPage().getByText('Neplatný e-mail nebo heslo.', { exact: true })).toBeVisible()
			await expectOnIam('/auth/login')
			const cookies = await getContext().cookies(NOTES_URL)
			expect(cookies.some((cookie) => cookie.name === SESSION_COOKIE)).toBe(false)
		})
	},
)
