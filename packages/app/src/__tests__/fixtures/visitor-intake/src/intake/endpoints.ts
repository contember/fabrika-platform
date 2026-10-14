// The intake job: drains the registration inbox into candidates, accepts resends, then delivers each due candidate's
// link of the `portal` mount. Its invariants, which a copy must keep:
// - each batch is bounded, and each record is its own work: a record that fails counts the attempt and keeps the step
//   that failed, the run goes on with the rest, and a record that failed MAX_ATTEMPTS times is dead until an operator
//   acts (a registration stays in its inbox, a delivery is 'failed'); a resend revives a dead delivery;
// - a record is claimed with `for update skip locked` in the transaction that consumes it, so a row other work holds
//   is left for a later run and blocks nothing behind it;
// - each delivery first reserves one e-mail of the recipient's daily budget, durably, so a delivery that fails after
//   the e-mail left is still counted;
// - each step is recorded in the candidate's row before the next effect, so the next run finishes a stopped one;
// - the link is the delivery's identity: its e-mail carries `Idempotency-Key: intake-link-<link id>`, and until it is
//   known sent the row keeps the link's URL sealed, so a retry hands the provider the same message under the same key
//   and the provider sends it once;
// - each e-mail has its own deadline inside the attempt's, so one hanging recipient counts its attempt and holds up no
//   other; an effect starts only while the attempt is live (`ctx.signal`), and a failure of an ended attempt is the
//   attempt's, never the record's.

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
	linkSeal: z.string().nullable(),
	revokeLinkId: z.string().nullable(),
})

/** A link lives a week; a recipient gets at most three e-mails a day, failed deliveries included. */
export const LINK_DAYS = 7
export const SENDS_PER_DAY = 3
/** The records one run takes of each kind; the next run takes the rest. */
export const BATCH = 50
/** A record that failed this many attempts is dead: the job leaves it to an operator. */
export const MAX_ATTEMPTS = 5
/** How long one e-mail may take: far inside the attempt's 15 minutes, so a hanging one is a counted failure. */
export const SEND_TIMEOUT_MS = 10_000

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
		tx.sql(Id)`select id from registrations where attempts < ${MAX_ATTEMPTS} order by received_at, id limit ${BATCH}`
	)
	for (const { id } of queued) {
		await eachRecord(() =>
			ctx.transaction(async (tx) => {
				// Claimed in the transaction that consumes it: a row other work holds is skipped, not waited for.
				const [row] = await tx.sql(Queued)`select id, email, name from registrations
					where id = ${id} and attempts < ${MAX_ATTEMPTS} for update skip locked`
				if (row === undefined) {
					return
				}
				await tx.sql(Id)`delete from registrations where id = ${row.id} returning id`
				await tx.sql(Id)`insert into candidates (id, email, name, created_by, version)
					values (${Bun.randomUUIDv7()}, ${row.email}, ${row.name}, ${ctx.principal.id}, 1)
					on conflict (email) do nothing returning id`
			}), async () => {
			const [dead] = await ctx.transaction((tx) =>
				tx.sql(z.strictObject({ attempts: z.number() }))`update registrations
					set attempts = attempts + 1, last_failure = 'register'
					where id = ${id} returning attempts`
			)
			if (dead !== undefined && dead.attempts >= MAX_ATTEMPTS) {
				console.error(`intake: registration ${id} failed ${MAX_ATTEMPTS} attempts; it waits in registrations for an operator`)
			}
		})
	}
	// A resend supersedes the link of an unverified candidate, sent or dead, while the budget has an e-mail left for it.
	await ctx.transaction(async (tx) => {
		const asks = await tx.sql(Resend)`delete from resend_requests
			where id in (select id from resend_requests order by received_at, id limit ${BATCH} for update skip locked)
			returning email`
		for (const ask of asks) {
			await tx.sql(Id)`update candidates
				set link_state = 'due', revoke_link_id = coalesce(link_id, revoke_link_id), link_id = null, link_seal = null,
					attempts = 0
				where email = ${ask.email} and verified_at is null and link_state in ('sent', 'failed')
					and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
				returning id`
		}
	})
	// Only a row whose budget has an e-mail left is due: spent rows would otherwise fill the batch and starve the rest.
	const due = await ctx.transaction((tx) =>
		tx.sql(Due)`select id, email, link_state, link_id, link_seal, revoke_link_id from candidates
			where link_state in ('due', 'issued') and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day')
			order by id limit ${BATCH}`
	)
	for (const candidate of due) {
		let step: Step = 'reserve'
		await eachRecord(async () => {
			// The e-mail this delivery may send is charged before anything else; a row other work holds waits for a later run.
			const reserved = await ctx.transaction((tx) =>
				tx.sql(Id)`update candidates set
						sends = case when window_started_at < now() - interval '1 day' then 1 else sends + 1 end,
						window_started_at = case when window_started_at < now() - interval '1 day' then now() else window_started_at end
					where id = (select id from candidates where id = ${candidate.id}
						and (sends < ${SENDS_PER_DAY} or window_started_at < now() - interval '1 day') for update skip locked)
					returning id`
			)
			if (reserved.length === 0) {
				return
			}
			// An issued link may already have been e-mailed: it is sent again from its sealed URL, never replaced.
			const issuedBefore = candidate.linkState === 'issued' && candidate.linkId !== null && candidate.linkSeal !== null
				? { id: candidate.linkId, seal: candidate.linkSeal }
				: null
			const superseded = candidate.revokeLinkId ?? (issuedBefore === null ? candidate.linkId : null)
			if (superseded !== null) {
				step = 'revoke'
				ctx.signal.throwIfAborted()
				await ctx.links.revoke(superseded)
				await world.after('revoked', candidate.id)
				await ctx.transaction((tx) => tx.sql(Id)`update candidates set revoke_link_id = null where id = ${candidate.id} returning id`)
			}
			let link: { readonly id: string; readonly url: string }
			if (issuedBefore !== null) {
				link = { id: issuedBefore.id, url: await world.open(issuedBefore.seal) }
			} else {
				step = 'issue'
				ctx.signal.throwIfAborted()
				const issued = await ctx.links.issue(await ctx.ref('candidates.invite', 'candidate', candidate.id), { mount: 'portal', days: LINK_DAYS })
				await world.after('issued', candidate.id)
				const sealed = await world.seal(issued.url)
				await ctx.transaction((tx) =>
					tx.sql(Id)`update candidates set link_state = 'issued', link_id = ${issued.id}, link_seal = ${sealed}
						where id = ${candidate.id} returning id`
				)
				await world.after('recorded', candidate.id)
				link = issued
			}
			step = 'send'
			ctx.signal.throwIfAborted()
			const deadline = AbortSignal.any([ctx.signal, AbortSignal.timeout(world.sendTimeoutMs ?? SEND_TIMEOUT_MS)])
			await world.send({ to: candidate.email, url: `${world.origin}${link.url}`, idempotencyKey: `intake-link-${link.id}` }, deadline)
			await world.after('mailed', candidate.id)
			await ctx.transaction((tx) =>
				tx.sql(Id)`update candidates set link_state = 'sent', link_seal = null, attempts = 0, last_failure = null
					where id = ${candidate.id} and link_id = ${link.id} returning id`
			)
		}, async () => {
			const [dead] = await ctx.transaction((tx) =>
				tx.sql(z.strictObject({ linkState: z.string() }))`update candidates
					set attempts = attempts + 1, last_failure = ${step},
						link_state = case when attempts + 1 >= ${MAX_ATTEMPTS} then 'failed' else link_state end,
						link_seal = case when attempts + 1 >= ${MAX_ATTEMPTS} then null else link_seal end
					where id = ${candidate.id} returning link_state`
			)
			if (dead?.linkState === 'failed') {
				console.error(`intake: the delivery to candidate ${candidate.id} failed ${MAX_ATTEMPTS} attempts; it waits as 'failed' for an operator`)
			}
		})
	}
})
