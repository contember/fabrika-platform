// One step of the original object's point-in-time restore (ADR-0070): the ops operation `restore`, served before the application boots.
// A step that names a migration record is the in-place rewind of a failed migration (ADR-0070 §9): on the object that
// serves, to the record's bookmark, only while every guard of the rewind holds.

import {
	OPS_DATA_REFUSED_STATUS,
	OPS_STALE_STATUS,
	type OpsDataRefusal,
	type OpsDataRefusalReason,
	type OpsMigrationRecord,
	type OpsMode,
	type OpsRestoreArm,
	type OpsRestorePrepareAt,
	type OpsRestorePrepareRecord,
	type OpsRestoreRequest,
	type OpsRestoreVerify,
	type OpsStaleRefusal,
	parseOpsRestoreArmAck,
	parseOpsRestorePrepareAck,
	parseOpsRestoreVerifyAck,
} from '@fabrika/auth-core'
import { jsonResponse } from '../errors.js'
import type { MaintenanceBarrier, TurnStep } from './maintenance.js'
import { type MigrationRecordStore, type StoredRecord, update } from './migration-record.js'
import type { OpsRecovery, OpsStorage, OpsTarget } from './ops.js'

/**
 * The KV key prefix of an operation's sentinel, followed by its id. KV, unlike R2, is rewound with the object's SQLite,
 * so the absence of an operation's key proves its restore; no operation writes another's.
 */
const SENTINEL_PREFIX = '__fabrika/restore-sentinel/'

const ABORT_REASON = 'fabrika: point-in-time restore armed'

/**
 * One step of the original object's point-in-time restore (ADR-0070 §9 step 6). `prepare` and `arm` run in the
 * barrier's turn, only under the published generation, on an object that is not the one ordinary traffic reaches
 * (`serving`), while it is `inspect`; `verify` writes nothing but an in-place rewind's outcome, and runs in any mode. A
 * step that names a migration record (`records`, the object's) may run on the serving object instead, under the rewind's
 * guards.
 */
export async function serveRestore(
	target: OpsTarget,
	barrier: MaintenanceBarrier,
	step: OpsRestoreRequest,
	serving: boolean,
	records: MigrationRecordStore,
): Promise<Response> {
	const { recovery } = target
	if (recovery === null) {
		return jsonResponse({ refused: 'not_implemented' }, 501)
	}
	const sentinels = kvSentinels(target.storage)
	switch (step.step) {
		case 'prepare':
			if ('record' in step) {
				return await inTurn(
					barrier,
					step.generation,
					false,
					() => rewindable(records, step.record, target.version, async (record) => await prepare(recovery, sentinels, step, async () => record)),
				)
			}
			return await inTurn(
				barrier,
				step.generation,
				serving,
				() => prepare(recovery, sentinels, step, async () => await recovery.getBookmarkForTime(Date.parse(step.at))),
			)
		case 'arm': {
			const armed = async () => {
				await barrier.restrictedWrite()
				return await arm(recovery, step)
			}
			const { record } = step
			if (record === undefined) {
				return await inTurn(barrier, step.generation, serving, armed)
			}
			return await inTurn(
				barrier,
				step.generation,
				false,
				() =>
					rewindable(
						records,
						record,
						target.version,
						async (bookmark) => bookmark === step.target ? await armed() : answered(dataRefusal('wrong_target')),
					),
			)
		}
		case 'verify':
			return await verify(recovery, sentinels, step, records)
	}
}

/**
 * The guards of the in-place rewind (ADR-0070 §9), checked in the barrier's turn after `inTurn` found the object
 * `inspect` under the published generation: the record is the one named, `committed` and never `booted`, written by the
 * Worker version that runs, which is known, and names its bookmark from before the transaction. `work` gets that
 * bookmark, the only target the rewind may have.
 */
async function rewindable(
	records: MigrationRecordStore,
	named: string,
	version: string | null,
	work: (bookmark: string) => Promise<TurnStep<Response>>,
): Promise<TurnStep<Response>> {
	let held: StoredRecord | null
	try {
		held = await records.read()
	} catch {
		return answered(new Response(null, { status: 503 }))
	}
	const record = held?.record
	if (record === undefined || record.id !== named || record.outcome !== 'committed' || record.booted !== null || record.bookmark === null) {
		return answered(dataRefusal('not_rewindable'))
	}
	if (record.version === null || record.version !== version) {
		return answered(dataRefusal('version_changed'))
	}
	return await work(record.bookmark)
}

/**
 * The first prepare of an operation reads the current bookmark, then the target's, and keeps both under its sentinel
 * key; a retried one answers what it kept. A target not lexically before the current bookmark would keep the sentinel.
 */
async function prepare(
	recovery: OpsRecovery,
	sentinels: SentinelStore,
	step: OpsRestorePrepareAt | OpsRestorePrepareRecord,
	targetBookmark: () => Promise<string>,
): Promise<TurnStep<Response>> {
	const kept = await sentinels.read(step.sentinel)
	if (kept !== undefined) {
		return answered(answer(parseOpsRestorePrepareAck(kept)))
	}
	const current = await recovery.getCurrentBookmark()
	let target: string
	try {
		target = await targetBookmark()
	} catch {
		return answered(dataRefusal('bookmark_unavailable'))
	}
	if (!(target < current)) {
		return answered(dataRefusal('bookmark_unavailable'))
	}
	const ack = parseOpsRestorePrepareAck({ step: 'prepare', current, target })
	if (ack !== null) {
		await sentinels.write(step.sentinel, ack)
	}
	return answered(answer(ack))
}

/** Arms the restore and resets the object once the answer is out, holding the barrier's turn until then. */
async function arm(recovery: OpsRecovery, step: OpsRestoreArm): Promise<TurnStep<Response>> {
	let undo: string
	try {
		undo = await recovery.onNextSessionRestoreBookmark(step.target)
	} catch {
		return answered(dataRefusal('bookmark_unavailable'))
	}
	const response = answer(parseOpsRestoreArmAck({ step: 'arm', undo }))
	// workerd's abort throws, so on a real object the turn is never released and no transition is acknowledged after it.
	const reset = new Promise<void>((resolve) =>
		setTimeout(() => {
			recovery.abort(ABORT_REASON)
			resolve()
		}, 0)
	)
	return { value: response, holdUntil: reset }
}

/**
 * Present while the KV holds this operation's key: a restore to a target before its `prepare` removed it. An in-place
 * rewind's absent sentinel first records `rewound` in the migration record it named, so no later boot marks the undone
 * migration `booted`; a record that could not be marked answers 503, and Control asks again.
 */
async function verify(recovery: OpsRecovery, sentinels: SentinelStore, step: OpsRestoreVerify, records: MigrationRecordStore): Promise<Response> {
	const present = (await sentinels.read(step.sentinel)) !== undefined
	if (!present && step.record !== undefined && !(await markedRewound(records, step.record))) {
		return new Response(null, { status: 503 })
	}
	return answer(parseOpsRestoreVerifyAck({ step: 'verify', sentinel: present ? 'present' : 'absent', bookmark: await recovery.getCurrentBookmark() }))
}

/** Whether the record named holds `rewound` now; a record of another id is left as it is, and so is one that never committed. */
async function markedRewound(records: MigrationRecordStore, named: string): Promise<boolean> {
	try {
		const held = await records.read()
		if (held === null || held.record.id !== named || held.record.outcome !== 'committed') {
			return true
		}
		const rewound: OpsMigrationRecord = { ...held.record, outcome: 'rewound' }
		await update(records, held, rewound)
		return true
	} catch {
		return false
	}
}

/**
 * ADR-0070 §1 and §9: inside the barrier's turn, ADR-0069's stale refusal unless `generation` is the published one,
 * then `serving_object` on the object of ordinary traffic, then `wrong_mode` unless `inspect`.
 */
async function inTurn(
	barrier: MaintenanceBarrier,
	generation: number,
	serving: boolean,
	work: () => Promise<TurnStep<Response>>,
): Promise<Response> {
	const result = await barrier.step(generation, (mode: OpsMode) => {
		if (serving) {
			return Promise.resolve(answered(dataRefusal('serving_object')))
		}
		return mode === 'inspect' ? work() : Promise.resolve(answered(dataRefusal('wrong_mode')))
	})
	if (result.kind === 'ran') {
		return result.value
	}
	const refusal: OpsStaleRefusal = { refused: 'stale_generation', published: result.published }
	return jsonResponse(refusal, OPS_STALE_STATUS)
}

function answered(response: Response): TurnStep<Response> {
	return { value: response, holdUntil: null }
}

function dataRefusal(reason: OpsDataRefusalReason): Response {
	const refusal: OpsDataRefusal = { refused: reason, table: null }
	return jsonResponse(refusal, OPS_DATA_REFUSED_STATUS)
}

/** An answer the wire's own parser accepted; a bookmark the storage handed out that it refuses fails the step. */
function answer(parsed: object | null): Response {
	if (parsed === null) {
		throw new Error("the object's restore answer does not parse as the wire's acknowledgement")
	}
	return jsonResponse(parsed, 200)
}

/** The operations' sentinels in the object's KV storage, each under its own key. */
interface SentinelStore {
	/** What the operation's key holds, `undefined` when it holds nothing. */
	read(sentinel: string): Promise<unknown>
	write(sentinel: string, value: unknown): Promise<void>
}

function kvSentinels(storage: OpsStorage): SentinelStore {
	return {
		async read(sentinel) {
			if (storage.get === undefined) {
				throw new Error("the object's storage has no get; a Durable Object's storage has it")
			}
			return await storage.get(`${SENTINEL_PREFIX}${sentinel}`)
		},
		async write(sentinel, value) {
			if (storage.put === undefined) {
				throw new Error("the object's storage has no put; a Durable Object's storage has it")
			}
			await storage.put(`${SENTINEL_PREFIX}${sentinel}`, value)
		},
	}
}
