import { actionLinkOf, createPasswordPerson, issuePasswordLink, readNotesPrincipal, waitForMail } from '@fabrika/local-stack/browser-support'
import { browserTest, byRole, expect, getContext, getPage, invariant, step } from '@opice/harness'
import { randomUUID } from 'node:crypto'
import { choosePassword, expectSignedInToNotes, IAM_URL, newMailbox, newPassword, NOTES_URL, signInFromNotes, submitSignIn } from './support/notes'

interface GuestInvitation {
	readonly workspaceId: string
	readonly email: string
	readonly label?: string
	readonly message?: string
	readonly resend?: boolean
}

/** Call `people.guests.invite` from the Notes page, as the signed-in person's browser does, and answer the status. */
async function inviteGuest(invitation: GuestInvitation): Promise<number> {
	return getPage().evaluate(async (body) => {
		const response = await fetch('/people/guests.invite', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
		return response.status
	}, invitation)
}

/** Open an invitation link and choose IAM's "accept" button, which answers what this browser may do next. */
async function acceptFromLink(link: string): Promise<void> {
	// From IAM's answer to an earlier link, the new one differs only in its fragment and would not load the page again.
	await getPage().goto('about:blank')
	await getPage().goto(link)
	await expect(getPage().locator('html')).toHaveAttribute('lang', 'cs')
	await expect(byRole('heading', 'Přijetí pozvánky', { exact: true, level: 1 })).toBeVisible()
	await byRole('button', 'Přijmout pozvánku', { exact: true }).click()
}

browserTest(
	{
		name: 'Staff invite a new person into two Notes workspaces; the person sets a password, signs in and accepts',
		url: `${NOTES_URL}/`,
		feature: 'iam-external-onboarding',
		seeds: ['local-stack'],
		roles: ['anonymous'],
		tier: 'standard',
	},
	async () => {
		const staffEmail = newMailbox('notes-staff')
		const staffPassword = newPassword()
		const guestEmail = newMailbox('notes-guest')
		const guestPassword = newPassword()
		const firstWorkspace = `browser-${randomUUID()}`
		const secondWorkspace = `browser-${randomUUID()}`
		let replacedLink = ''
		let firstLink = ''

		await step('a staff member of Notes signs in from Notes', {
			intent: 'the staff role is application-wide and may assign the external guest role in every workspace',
			manual: 'In the console, invite a user, grant the Notes staff role and choose "Enable password". Set it from the e-mail and sign in to Notes.',
		}, async () => {
			const staff = await createPasswordPerson(staffEmail, 'staff')
			await getPage().goto(await issuePasswordLink(staff, 'enrollment'))
			await choosePassword({ title: 'Set your password', label: 'New password', button: 'Set your password' }, staffPassword)
			await expect.poll(() => new URL(getPage().url()).origin).toBe(IAM_URL)
			await signInFromNotes(staffEmail, staffPassword)
			await expectSignedInToNotes()
		})

		await step('the staff member invites a new mailbox with a label and a message, then resends it', {
			intent: 'IAM mails the invitation in Czech with what the application passed, and a resend mails a new link',
			manual: 'In Notes, invite the address into a workspace as a guest of "Acme", with a message, then resend the invitation.',
		}, async () => {
			const invitedAt = Date.now()
			expect(await inviteGuest({ workspaceId: firstWorkspace, email: guestEmail, label: 'Acme', message: 'Vítejte v Notes.' })).toBe(200)
			const invitation = await waitForMail({ to: guestEmail, since: invitedAt })
			expect(invitation.subject).toMatch(/^Pozvánka do aplikace /)
			expect(invitation.text).toContain(' za Acme')
			expect(invitation.text).toContain('Vítejte v Notes.')
			replacedLink = actionLinkOf(invitation)

			const resentAt = Date.now()
			expect(await inviteGuest({ workspaceId: firstWorkspace, email: guestEmail, resend: true })).toBe(200)
			const resent = await waitForMail({ to: guestEmail, since: resentAt })
			firstLink = actionLinkOf(resent)
			expect(firstLink).not.toBe(replacedLink)
		})

		await step('the link the resend replaced is refused', {
			intent: 'a resend rotates the token, so the first link stops working before anyone used it',
			manual: 'Open the link of the first e-mail and choose "Přijmout pozvánku". Verify that the link is not available.',
		}, async () => {
			await acceptFromLink(replacedLink)
			await expect(byRole('heading', 'Odkaz není k dispozici', { exact: true, level: 1 })).toBeVisible()
		})

		await step('a browser signed in as the staff member is refused the creating form', {
			intent: 'the invitation would create a new account, and this browser holds another one, so IAM offers no password form',
			manual: 'In the staff member’s browser, open the invitation link and choose "Přijmout pozvánku". Verify that it asks to sign out first.',
		}, async () => {
			await acceptFromLink(firstLink)
			await expect(byRole('heading', 'Jste přihlášeni jiným účtem', { exact: true, level: 1 })).toBeVisible()
			await expect(getPage().getByText(guestEmail)).toBeVisible()
			await expect(getPage().locator('input[type="password"]')).toHaveCount(0)
			expect(await readNotesPrincipal(guestEmail)).toBeNull()
		})

		await step('the invited person sets a password from the e-mail and lands in Notes as an external guest', {
			intent: 'one e-mail onboards a new person: the account, its password and the guest role are created at acceptance',
			manual: 'In a private browser, open the invitation link, choose "Přijmout pozvánku", choose a password, and verify that Notes opens.',
		}, async () => {
			await getContext().clearCookies()
			await acceptFromLink(firstLink)
			await choosePassword({ title: 'Zvolte si heslo', label: 'Nové heslo', button: 'Nastavit heslo a přijmout' }, guestPassword)
			await expectSignedInToNotes()
			expect(await readNotesPrincipal(guestEmail)).toEqual({ affiliation: 'external', roles: [{ role: 'guest', workspace: firstWorkspace }] })
		})

		await step('a second workspace invites the same person, who signs in from the invitation and accepts', {
			intent: 'an existing person signs in through Notes first, then the same link accepts the invitation and lands in Notes',
			manual:
				'As the staff member, invite the same address into another workspace. In a private browser, open the link, choose "Přijmout pozvánku" and "Přihlásit se", sign in, open the link again and accept.',
		}, async () => {
			await signInFromNotes(staffEmail, staffPassword)
			await expectSignedInToNotes()
			const invitedAt = Date.now()
			expect(await inviteGuest({ workspaceId: secondWorkspace, email: guestEmail })).toBe(200)
			const secondLink = actionLinkOf(await waitForMail({ to: guestEmail, since: invitedAt }))

			await getContext().clearCookies()
			await acceptFromLink(secondLink)
			await expect(byRole('heading', 'Nejprve se přihlaste', { exact: true, level: 1 })).toBeVisible()
			await getPage().getByRole('link', { name: 'Přihlásit se', exact: true }).click()
			await expect(byRole('heading', 'Přihlášení', { exact: true, level: 1 })).toBeVisible()
			await submitSignIn(guestEmail, guestPassword)
			await expectSignedInToNotes()

			await acceptFromLink(secondLink)
			await expectSignedInToNotes()
		})

		await invariant('the guest holds the guest role in both workspaces and nothing else', async () => {
			const principal = await readNotesPrincipal(guestEmail)
			expect(principal?.affiliation).toBe('external')
			expect(principal?.roles.map((grant) => grant.workspace).sort()).toEqual([firstWorkspace, secondWorkspace].sort())
			expect(principal?.roles.every((grant) => grant.role === 'guest')).toBe(true)
		})
	},
)
