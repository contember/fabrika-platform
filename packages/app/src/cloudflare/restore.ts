// One step of the original object's point-in-time restore (ADR-0070): the ops operation `restore`, served before the application boots.

import {
	OPS_DATA_REFUSED_STATUS,
	OPS_STALE_STATUS,
	type OpsDataRefusal,
	type OpsDataRefusalReason,
	type OpsMode,
	type OpsRestoreArm,
	type OpsRestorePrepare,
	type OpsRestoreRequest,
	type OpsRestoreVerify,
	type OpsStaleRefusal,
	parseOpsRestoreArmAck,
	parseOpsRestorePrepareAck,
	parseOpsRestoreVerifyAck,
} from '@fabrika/auth-core'
import { jsonResponse } from '../errors.js'
import type { MaintenanceBarrier, TurnStep } from './maintenance.js'
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
 * (`serving`), while it is `inspect`; `verify` writes nothing and runs in any mode.
 */
export async function serveRestore(target: OpsTarget, barrier: MaintenanceBarrier, step: OpsRestoreRequest, serving: boolean): Promise<Response> {
	const { recovery } = target
	if (recovery === null) {
		return jsonResponse({ refused: 'not_implemented' }, 501)
	}
	const sentinels = kvSentinels(target.storage)
	switch (step.step) {
		case 'prepare':
			return await inTurn(barrier, step.generation, serving, () => prepare(recovery, sentinels, step))
		case 'arm':
			return await inTurn(barrier, step.generation, serving, async () => {
				await barrier.restrictedWrite()
				return await arm(recovery, step)
			})
		case 'verify':
			return await verify(recovery, sentinels, step)
	}
}

/**
 * The first prepare of an operation reads the current bookmark, then the target's, and keeps both under its sentinel
 * key; a retried one answers what it kept. A target not lexically before the current bookmark would keep the sentinel.
 */
async function prepare(recovery: OpsRecovery, sentinels: SentinelStore, step: OpsRestorePrepare): Promise<TurnStep<Response>> {
	const kept = await sentinels.read(step.sentinel)
	if (kept !== undefined) {
		return answered(answer(parseOpsRestorePrepareAck(kept)))
	}
	const current = await recovery.getCurrentBookmark()
	let target: string
	try {
		target = await recovery.getBookmarkForTime(Date.parse(step.at))
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

/** Present while the KV holds this operation's key: a restore to a target before its `prepare` removed it. */
async function verify(recovery: OpsRecovery, sentinels: SentinelStore, step: OpsRestoreVerify): Promise<Response> {
	const present = (await sentinels.read(step.sentinel)) !== undefined
	return answer(parseOpsRestoreVerifyAck({ step: 'verify', sentinel: present ? 'present' : 'absent', bookmark: await recovery.getCurrentBookmark() }))
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
