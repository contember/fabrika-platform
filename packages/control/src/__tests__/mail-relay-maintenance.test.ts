// The relay's share of maintenance: lost queued messages and stale claims are re-enqueued, and final messages forget
// their content after the retention. Against the shipped SQLite schema.

import { type JobQueue, uuidv7 } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import type { MailMessageRepository, MailMessageState } from '../db'
import { MAIL_STALE_CLAIM_S } from '../mail-relay/dispatch'
import { MAIL_CONTENT_RETENTION_S, MAIL_STALE_QUEUED_S, runMailMaintenance } from '../mail-relay/maintenance'
import type { MailDispatchMessage } from '../mail-relay/queue'
import { createHarness } from './helpers/harness'

const NOW = 1_800_000_000

async function message(messages: MailMessageRepository, state: MailMessageState, at: number, sender = 'notes@prod'): Promise<string> {
	const { row } = await messages.insertOrFind({
		id: uuidv7(),
		sender,
		idempotency_key: uuidv7(),
		fingerprint: 'f'.repeat(64),
		recipient_domain: 'example.com',
		state,
		rule_id: null,
		content: '{"to":"ada@example.com"}',
	}, at)
	return row.id
}

function maintenance() {
	const harness = createHarness()
	const jobs: MailDispatchMessage[] = []
	const queue: JobQueue<MailDispatchMessage> = {
		send(job) {
			jobs.push(job)
			return Promise.resolve()
		},
	}
	return { messages: harness.repositories.mailMessages, jobs, queue }
}

describe('mail maintenance', () => {
	test('re-enqueues a queued message unchanged for ten minutes, and nothing fresh, deferred or not queued', async () => {
		const m = maintenance()
		const lost = await message(m.messages, 'queued', NOW - MAIL_STALE_QUEUED_S)
		await message(m.messages, 'queued', NOW - MAIL_STALE_QUEUED_S + 1)
		await message(m.messages, 'held', NOW - 3600)
		const deferred = await message(m.messages, 'queued', NOW - 3600)
		await m.messages.claim(deferred, 0, NOW - 3600)
		await m.messages.defer(deferred, 1, NOW + 60, 'provider_unavailable', NOW - 3600)

		expect(await runMailMaintenance({ messages: m.messages, queue: m.queue, now: NOW })).toEqual({ requeued: 1, purged: 0, collected: 0 })
		expect(m.jobs).toEqual([{ messageId: lost }])
	})

	test('re-enqueues an attempt whose claim went stale, and not one a consumer may still hold', async () => {
		const m = maintenance()
		const stale = await message(m.messages, 'queued', NOW - 3600)
		await m.messages.claim(stale, 0, NOW - MAIL_STALE_CLAIM_S)
		const fresh = await message(m.messages, 'queued', NOW - 3600)
		await m.messages.claim(fresh, 0, NOW - MAIL_STALE_CLAIM_S + 1)
		await runMailMaintenance({ messages: m.messages, queue: m.queue, now: NOW })
		expect(m.jobs).toEqual([{ messageId: stale }])
	})

	test('re-enqueues a deferred message whose next attempt is overdue', async () => {
		const m = maintenance()
		const overdue = await message(m.messages, 'queued', NOW - 3600)
		await m.messages.claim(overdue, 0, NOW - 3600)
		await m.messages.defer(overdue, 1, NOW - 1, 'provider_unavailable', NOW - 3600)
		await runMailMaintenance({ messages: m.messages, queue: m.queue, now: NOW })
		expect(m.jobs).toEqual([{ messageId: overdue }])
	})

	test('without a dispatcher (the Worker) it re-enqueues nothing', async () => {
		const m = maintenance()
		await message(m.messages, 'queued', NOW - 3600)
		expect(await runMailMaintenance({ messages: m.messages, now: NOW })).toEqual({ requeued: 0, purged: 0, collected: 0 })
	})

	test('forgets the content of final messages after thirty days, and keeps every other', async () => {
		const m = maintenance()
		const old = NOW - MAIL_CONTENT_RETENTION_S
		const expired = await Promise.all(
			(['failed', 'unknown', 'dropped'] satisfies MailMessageState[]).map((state) => message(m.messages, state, old)),
		)
		const sentOld = await message(m.messages, 'queued', old)
		await m.messages.claim(sentOld, 0, old)
		await m.messages.markSent(sentOld, 'provider-1', 1, old)
		const recent = await message(m.messages, 'failed', old + 1)
		const heldOld = await message(m.messages, 'held', old)

		expect(await runMailMaintenance({ messages: m.messages, now: NOW })).toEqual({ requeued: 0, purged: 4, collected: 0 })
		for (const id of [...expired, sentOld]) expect((await m.messages.get(id))?.content).toBeNull()
		for (const id of [recent, heldOld]) expect((await m.messages.get(id))?.content).not.toBeNull()
	})
})
