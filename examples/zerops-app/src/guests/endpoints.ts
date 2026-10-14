// The guests: a staff member invites a person from outside the organization into a workspace by e-mail. IAM sends the
// invitation, and the person sets a password and lands in Notes; a repeated invite with `resend` sends a new link.

import { app } from '../app-kit'
import { Invited, InviteGuest } from '../schemas'

export const guests = app.group({ callers: ['human'] }, (r) => ({
	invite: r.mutation({ input: InviteGuest, output: Invited, access: { action: 'members.manage', in: 'workspace', from: 'workspaceId' } })
		.handle(async ({ input, ctx }) => {
			const { email, label, message, resend } = input
			const result = await ctx.members.assign(ctx.target, { email }, 'guest', { label, message, resend })
			return { invitationId: 'invited' in result ? result.invited.invitationId : result.assigned.principalId }
		}),
}))
