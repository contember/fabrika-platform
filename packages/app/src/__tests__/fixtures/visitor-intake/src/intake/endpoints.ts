// The intake job: drains the registration inbox into candidates, accepts resends, then delivers each due candidate's
// link of the `portal` mount. Its invariants, which a copy must keep:
// - each batch is bounded, and each record is its own work: a record that fails counts the attempt and keeps the step
//   that failed, the run goes on with the rest, and a record that failed MAX_ATTEMPTS times is dead until an operator
//   acts (a registration stays in its inbox, a delivery is 'failed'); a resend revives a dead delivery;
// - each delivery first reserves one e-mail of the recipient's daily budget, durably, so a delivery that fails after
//   the e-mail left is still counted;
// - each step is recorded in the candidate's row before the next effect, so the next run finishes a stopped one;
// - the e-mail carries a key derived from its link (`intake-link-<link id>`), so the provider sends one message per
//   link, however often the job hands it over;
// - an effect starts only while the attempt is live (`ctx.signal`), and the e-mail takes the signal: the runner aborts
//   it before a replacement attempt starts, so no effect of a stale attempt follows the replacement's. A failure of an
//   ended attempt is the attempt's, never the record's.

import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Resend } from '../schemas'
import { intakeDeps } from '../world'

const Id = z.strictObject({ id: z.string() })
const Queued = z.strictObject({ id: z.string(), email: z.string(), name: z.string() })
const Due = z.strictObject({
	id: z.string(),
	email: z.string(),
	linkState: z.enum(['due', 'issued']),
	linkId: z.string().nullable(),
	revokeLinkId: z.string().nullable(),
})

/** A link lives a week; a recipient gets at most three e-mails a day, failed deliveries included. */
export const LINK_DAYS = 7
export const SENDS_PER_DAY = 3
/** The records one run takes of each kind; the next run takes the rest. */
export const BATCH = 50
/** A record that failed this many attempts is dead: the job leaves it to an operator. */
export const MAX_ATTEMPTS = 5

/** The step of a delivery that failed last: a fixed code, never an error's message, which can quote the address. */
type Step = 'reserve' | 'revoke' | 'issue' | 'send'

export const intake = app.cron('* * * * *', {
	actions: ['candidates.process', 'candidates.invite', 'candidates.read', 'candidates.verify', 'candidates.attach'],
	scope: 'app',
	retries: 0,
	sql: 'write',
	issues: 'portal',
}).handle(async ({ ctx }) => {
	const world = intakeDeps.get()
	/**
	 * Runs one record's `work`. A failure is the record's (`failed` records it) and the run goes on, unless the attempt
	 * itself ended: then the attempt fails, and the next run meets the record as this one left it.
	 */
	const eachRecord = async (work: () => Promise<void>, failed: () => Promise<void>): Promise<void> => {
		try {
			await work()
		} catch (error) {
			if (ctx.signal.aborted) {
				throw error
			}
			await failed()
		}
	}
	// A registration becomes a candidate once, whatever the form received; the form told the visitor nothing either way.
	const queued = await ctx.transaction((tx) =>
		tx.sql(Queued)`select id, email, name from registrations where attempts < ${MAX_ATTEMPTS}
			order by received_at, id limit ${BATCH}`
	)
	for (const row of queued) {
		await eachRecord(() =>
			ctx.transaction(async (tx) => {
				if ((await tx.sql(Id)`delete from registrations where id = ${row.id} returning id`).length > 0) {
					await tx.sql(Id)`insert into candidates (id, email, name, created_by, version)
						values (${Bun.randomUUIDv7()}, ${row.email}, ${row.name}, ${ctx.principal.id}, 1)
						on conflict (email) do nothing returning id`
				}
			}), async () => {
			const [dead] = await ctx.transaction((tx) =>
				tx.sql(z.strictObject({ attempts: z.number() }))`update registrations
					set attempts = attempts + 1, last_failure = 'register'
					where id = ${row.id} returning attempts`
			)
			if (dead !== undefined && dead.attempts >= MAX_ATTEMPTS) {
				console.error(`intake: registration ${row.id} failed ${MAX_ATTEMPTS} attempts; it waits in registrations for an operator`)
			}
		})
	}
	// A resend supersedes the link of an unverified candidate, sent or dead, while the budget has an e-mail left for it.
	await ctx.transaction(async (tx) => {
		const asks = await tx.sql(Resend)`delete from resend_requests
			where id in (select id from resend_requests order by received_at, id limit ${BATCH}) returning email`
		for (const ask of asks) {
			await tx.sql(Id)`update candidates
				set link_state = 'due', revoke_link_id = coalesce(link_id, revoke_link_id), link_id = null, attempts = 0
				where email = ${ask.email} and verified_at is null and link_state in ('sent', 'failed')
					and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
				returning id`
		}
	})
	// Only a row whose budget has an e-mail left is due: spent rows would otherwise fill the batch and starve the rest.
	const due = await ctx.transaction((tx) =>
		tx.sql(Due)`select id, email, link_state, link_id, revoke_link_id from candidates
			where link_state in ('due', 'issued') and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
			order by id limit ${BATCH}`
	)
	for (const candidate of due) {
		let step: Step = 'reserve'
		await eachRecord(async () => {
			// The e-mail this delivery may send is charged before anything else; without one left, the row waits as it is.
			const reserved = await ctx.transaction((tx) =>
				tx.sql(Id)`update candidates set
						sends = case when window_started_at < now() - interval '1 day' then 1 else sends + 1 end,
						window_started_at = case when window_started_at < now() - interval '1 day' then now() else window_started_at end
					where id = ${candidate.id} and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
					returning id`
			)
			if (reserved.length === 0) {
				return
			}
			// A link recorded but not known to be e-mailed, or one a resend superseded, ends before the next is issued.
			const superseded = candidate.linkState === 'issued' ? candidate.linkId : candidate.revokeLinkId
			if (superseded !== null) {
				step = 'revoke'
				ctx.signal.throwIfAborted()
				await ctx.links.revoke(superseded)
				await world.after('revoked', candidate.id)
				await ctx.transaction((tx) =>
					tx.sql(Id)`update candidates set link_state = 'due', link_id = null, revoke_link_id = null where id = ${candidate.id} returning id`
				)
			}
			step = 'issue'
			ctx.signal.throwIfAborted()
			const link = await ctx.links.issue(await ctx.ref('candidates.invite', 'candidate', candidate.id), { mount: 'portal', days: LINK_DAYS })
			await world.after('issued', candidate.id)
			await ctx.transaction((tx) =>
				tx.sql(Id)`update candidates set link_state = 'issued', link_id = ${link.id} where id = ${candidate.id} returning id`
			)
			await world.after('recorded', candidate.id)
			step = 'send'
			ctx.signal.throwIfAborted()
			await world.send({ to: candidate.email, url: `${world.origin}${link.url}`, idempotencyKey: `intake-link-${link.id}` }, ctx.signal)
			await world.after('mailed', candidate.id)
			await ctx.transaction((tx) =>
				tx.sql(Id)`update candidates set link_state = 'sent', attempts = 0, last_failure = null
					where id = ${candidate.id} and link_id = ${link.id} returning id`
			)
		}, async () => {
			const [dead] = await ctx.transaction((tx) =>
				tx.sql(z.strictObject({ linkState: z.string() }))`update candidates
					set attempts = attempts + 1, last_failure = ${step},
						link_state = case when attempts + 1 >= ${MAX_ATTEMPTS} then 'failed' else link_state end
					where id = ${candidate.id} returning link_state`
			)
			if (dead?.linkState === 'failed') {
				console.error(`intake: the delivery to candidate ${candidate.id} failed ${MAX_ATTEMPTS} attempts; it waits as 'failed' for an operator`)
			}
		})
	}
})
