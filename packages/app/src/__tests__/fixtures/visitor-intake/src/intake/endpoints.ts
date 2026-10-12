// The intake job: drains the registration inbox into candidates, accepts resends, then delivers each due candidate's
// link of the `portal` mount. Its invariants, which a copy must keep:
// - each delivery first reserves one e-mail of the recipient's daily budget, durably, so a delivery that fails after
//   the e-mail left is still counted;
// - each step is recorded in the candidate's row before the next effect, so the next run finishes a stopped one;
// - an effect starts only while the attempt is live (`ctx.signal`), and the e-mail takes the signal: the runner aborts
//   it before a replacement attempt starts, so no effect of a stale attempt follows the replacement's.

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

/** A link lives a week; a recipient gets at most three e-mails a day, failed deliveries included. */
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
	// A resend supersedes the sent link of an unverified candidate, only while the budget has an e-mail left for it.
	await ctx.transaction(async (tx) => {
		for (const ask of await tx.sql(Resend)`delete from resend_requests returning email`) {
			await tx.sql(Id)`update candidates set link_state = 'due', revoke_link_id = link_id, link_id = null
				where email = ${ask.email} and verified_at is null and link_state = 'sent'
					and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
				returning id`
		}
	})
	const due = await ctx.transaction((tx) =>
		tx.sql(Due)`select id, email, link_state, link_id, revoke_link_id from candidates where link_state <> 'sent' order by id limit 50`
	)
	for (const candidate of due) {
		// The e-mail this delivery may send is charged before anything else; without one left, the row waits as it is.
		const reserved = await ctx.transaction((tx) =>
			tx.sql(Id)`update candidates set
					sends = case when window_started_at < now() - interval '1 day' then 1 else sends + 1 end,
					window_started_at = case when window_started_at < now() - interval '1 day' then now() else window_started_at end
				where id = ${candidate.id} and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
				returning id`
		)
		if (reserved.length === 0) {
			continue
		}
		// A link recorded but not known to be e-mailed, or one a resend superseded, ends before the next is issued.
		const superseded = candidate.linkState === 'issued' ? candidate.linkId : candidate.revokeLinkId
		if (superseded !== null) {
			ctx.signal.throwIfAborted()
			await ctx.links.revoke(superseded)
			await world.after('revoked', candidate.id)
			await ctx.transaction((tx) =>
				tx.sql(Id)`update candidates set link_state = 'due', link_id = null, revoke_link_id = null where id = ${candidate.id} returning id`
			)
		}
		ctx.signal.throwIfAborted()
		const link = await ctx.links.issue(await ctx.ref('candidates.invite', 'candidate', candidate.id), { mount: 'portal', days: LINK_DAYS })
		await world.after('issued', candidate.id)
		await ctx.transaction((tx) => tx.sql(Id)`update candidates set link_state = 'issued', link_id = ${link.id} where id = ${candidate.id} returning id`)
		await world.after('recorded', candidate.id)
		ctx.signal.throwIfAborted()
		await world.send({ to: candidate.email, url: `${world.origin}${link.url}` }, ctx.signal)
		await world.after('mailed', candidate.id)
		await ctx.transaction((tx) =>
			tx.sql(Id)`update candidates set link_state = 'sent' where id = ${candidate.id} and link_id = ${link.id} returning id`
		)
	}
})
