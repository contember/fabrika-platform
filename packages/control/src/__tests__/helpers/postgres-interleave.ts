// Real concurrent transactions on Postgres, interleaved on purpose. A held connection runs a repository's batch as it
// ships, then waits before COMMIT on an advisory lock the test holds, so its row locks stay held. A contender on another
// connection starts its write; the test waits until Postgres reports it blocked, then lets the held one commit.

import type { SqlDatabase, SqlQueryResult, SqlStatement } from '@fabrika/platform'
import { PostgresDatabase } from '@fabrika/platform-node'

const WAIT_MS = 10_000

export interface Interleaving {
	/** Repositories over this connection run every batch, then wait for `commit()` before it commits. */
	readonly held: SqlDatabase
	/** A connection whose writes the test watches block. */
	readonly contender: PostgresDatabase
	/** Resolves once the held connection has run its batch and waits to commit. */
	heldReady(): Promise<void>
	/** Resolves once the contender waits on a row lock. */
	contenderBlocked(): Promise<void>
	/** Let the held batch commit. */
	commit(): Promise<void>
	close(): Promise<void>
}

export async function interleaving(url: string, schema: string): Promise<Interleaving> {
	const tag = Math.random().toString(36).slice(2, 10)
	const names = { held: `held_${tag}`, contender: `contender_${tag}` }
	const key = Math.floor(Math.random() * 2 ** 31)
	const connect = (name: string) => PostgresDatabase.connect(url, { connection: { search_path: schema, application_name: name }, max: 1 })
	const gate = connect(`gate_${tag}`)
	const heldRaw = connect(names.held)
	const contender = connect(names.contender)
	await gate.prepare('SELECT pg_advisory_lock(?::bigint)').bind(key).run()

	const held: SqlDatabase = {
		prepare: (sql: string): SqlStatement => heldRaw.prepare(sql),
		async batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]> {
			const results = await heldRaw.batch<T>([
				...statements,
				heldRaw.prepare('SELECT 1 FROM (SELECT pg_advisory_xact_lock(?::bigint)) AS waited').bind(key),
			])
			return results.slice(0, -1)
		},
	}
	const waitingOn = async (name: string, advisory: boolean): Promise<void> => {
		const deadline = Date.now() + WAIT_MS
		while (Date.now() < deadline) {
			const row = await gate
				.prepare(`SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
					WHERE application_name = ? AND wait_event_type = 'Lock' AND (wait_event = 'advisory') = ?`)
				.bind(name, advisory)
				.first<{ waiting: number }>()
			if ((row?.waiting ?? 0) > 0) return
			await Bun.sleep(20)
		}
		throw new Error(`${name} never waited on a ${advisory ? 'commit gate' : 'row lock'}`)
	}
	return {
		held,
		contender,
		heldReady: () => waitingOn(names.held, true),
		contenderBlocked: () => waitingOn(names.contender, false),
		async commit(): Promise<void> {
			await gate.prepare('SELECT pg_advisory_unlock(?::bigint)').bind(key).run()
		},
		async close(): Promise<void> {
			await Promise.all([gate.close(), heldRaw.close(), contender.close()])
		},
	}
}
