import { actionLinkOf, createPasswordPerson, issuePasswordLink, type PasswordPerson, waitForMail } from '@fabrika/local-stack/browser-support'
import { browserTest, byRole, expect, getPage, invariant, step } from '@opice/harness'
import {
	choosePassword,
	expectOnIam,
	expectSignedInToNotes,
	IAM_URL,
	newMailbox,
	newPassword,
	NOTES_URL,
	openNotesSignedOut,
	signInFromNotes,
} from './support/notes'

browserTest(
	{
		name: 'A Notes reader who forgot the password resets it from Notes in Czech and lands back in Notes',
		url: `${NOTES_URL}/`,
		feature: 'iam-password-onboarding',
		seeds: ['local-stack'],
		roles: ['anonymous'],
		tier: 'standard',
	},
	async () => {
		let person: PasswordPerson | undefined
		const forgottenPassword = newPassword()
		const newOne = newPassword()
		let requestedAt = 0

		function createdPerson(): PasswordPerson {
			if (person === undefined) throw new Error('the person was not created')
			return person
		}

		await step('a Notes reader has a password', {
			intent: 'the person signs in by password and has one to forget',
			manual: 'In the console, invite a user, grant the Notes reader role and choose "Enable password". Set it from the e-mail.',
		}, async () => {
			person = await createPasswordPerson(newMailbox('notes-forgot'))
			await getPage().goto(await issuePasswordLink(createdPerson(), 'enrollment'))
			await choosePassword({ title: 'Set your password', label: 'New password', button: 'Set your password' }, forgottenPassword)
			await expect.poll(() => new URL(getPage().url()).origin).toBe(IAM_URL)
		})

		await step('the person asks for a reset from the sign-in page Notes sent it to', {
			intent: "the sign-in page offers forgot-password once IAM can send e-mail, and the request keeps Notes' language",
			manual: 'In a private browser, open Notes. Choose "Zapomenuté heslo?", enter the address, and choose "Pokračovat".',
		}, async () => {
			await openNotesSignedOut()
			await getPage().getByRole('link', { name: 'Zapomenuté heslo?', exact: true }).click()
			await expectOnIam('/auth/forgot-password')
			await expect(byRole('heading', 'Obnovení hesla', { exact: true, level: 1 })).toBeVisible()
			requestedAt = Date.now()
			await getPage().getByLabel('E-mail', { exact: true }).fill(createdPerson().email)
			await byRole('button', 'Pokračovat', { exact: true }).click()
			await expect(byRole('heading', 'Žádost přijata', { exact: true, level: 1 })).toBeVisible()
		})

		await step('the reset e-mail is Czech, and its link sets a new password and opens Notes', {
			intent: "the action keeps the application: its page speaks Czech, and the completed reset lands on Notes' registered origin",
			manual: 'Open the e-mail. Verify that it is in Czech. Open its link, set a new password, and verify that Notes opens signed in.',
		}, async () => {
			const email = await waitForMail({ to: createdPerson().email, since: requestedAt })
			expect(email.subject).toBe('Obnovení hesla')
			await getPage().goto(actionLinkOf(email))
			await expect(getPage().locator('html')).toHaveAttribute('lang', 'cs')
			await choosePassword({ title: 'Obnovte si heslo', label: 'Nové heslo', button: 'Obnovte si heslo' }, newOne)
			await expectSignedInToNotes()
		})

		await invariant('the forgotten password no longer signs in, and the new one does', async () => {
			await signInFromNotes(createdPerson().email, forgottenPassword)
			await expect(getPage().getByText('Neplatný e-mail nebo heslo.', { exact: true })).toBeVisible()
			await signInFromNotes(createdPerson().email, newOne)
			await expectSignedInToNotes()
		})
	},
)
