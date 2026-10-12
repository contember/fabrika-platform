// The intake job: drains the registration inbox into candidates, applies resends within each recipient's budget, then
// delivers each due candidate's link of the `portal` mount. It records each delivery step in the candidate's row before
// the next effect, so a run that stops between any two effects (IAM, the e-mail, the row) is finished by the next run.

import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Register, Resend } from '../schemas'
import { intakeDeps } from '../world'

const Id = z.strictObject({ id: z.string() })
const Due = z.strictObject({
	id: z.string(),
	email: z.string(),
	linkState: z.enum(['due', 'issued', 'sent']),
	linkId: z.string().nullable(),
	revokeLinkId: z.string().nullable(),
})

/** A link lives a week; a recipient gets at most three e-mails a day. */
export const LINK_DAYS = 7
export const SENDS_PER_DAY = 3

export const intake = app.cron('* * * * *', {
	actions: ['candidates.process', 'candidates.invite', 'candidates.read', 'candidates.verify', 'candidates.attach'],
	scope: 'app',
	retries: 0,
	sql: 'write',
	issues: 'portal',
}).handle(async ({ ctx }) => {
	const world = intakeDeps.get()
	// A registration becomes a candidate once, whatever the form received; the form told the visitor nothing either way.
	await ctx.transaction(async (tx) => {
		for (const row of await tx.sql(Register)`delete from registrations returning email, name`) {
			await tx.sql(Id)`insert into candidates (id, email, name, created_by, version)
				values (${Bun.randomUUIDv7()}, ${row.email}, ${row.name}, ${ctx.principal.id}, 1)
				on conflict (email) do nothing returning id`
		}
	})
	// A resend supersedes the sent link of an unverified candidate, within the recipient's daily budget.
	await ctx.transaction(async (tx) => {
		for (const ask of await tx.sql(Resend)`delete from resend_requests returning email`) {
			await tx.sql(Id)`update candidates set
					sends = case when window_started_at < now() - interval '1 day' then 0 else sends end,
					window_started_at = case when window_started_at < now() - interval '1 day' then now() else window_started_at end,
					link_state = 'due', revoke_link_id = link_id, link_id = null
				where email = ${ask.email} and verified_at is null and link_state = 'sent'
					and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
				returning id`
		}
	})
	const due = await ctx.transaction((tx) =>
		tx.sql(Due)`select id, email, link_state, link_id, revoke_link_id from candidates where link_state <> 'sent' order by id limit 50`
	)
	for (const candidate of due) {
		// A link recorded but not known to be e-mailed, or one a resend superseded, ends before the next is issued.
		const superseded = candidate.linkState === 'issued' ? candidate.linkId : candidate.revokeLinkId
		if (superseded !== null) {
			await ctx.links.revoke(superseded)
			await world.after('revoked', candidate.id)
			await ctx.transaction((tx) =>
				tx.sql(Id)`update candidates set link_state = 'due', link_id = null, revoke_link_id = null where id = ${candidate.id} returning id`
			)
		}
		const link = await ctx.links.issue(await ctx.ref('candidates.invite', 'candidate', candidate.id), { mount: 'portal', days: LINK_DAYS })
		await world.after('issued', candidate.id)
		await ctx.transaction((tx) => tx.sql(Id)`update candidates set link_state = 'issued', link_id = ${link.id} where id = ${candidate.id} returning id`)
		await world.after('recorded', candidate.id)
		await world.send({ to: candidate.email, url: `${world.origin}${link.url}` })
		await world.after('mailed', candidate.id)
		await ctx.transaction((tx) =>
			tx.sql(Id)`update candidates set link_state = 'sent', sends = sends + 1 where id = ${candidate.id} and link_id = ${link.id} returning id`
		)
	}
})
