// One step of the original object's point-in-time restore (ADR-0070): the ops operation `restore`, served before the application boots.

import {
	OPS_DATA_REFUSED_STATUS,
	OPS_STALE_STATUS,
	type OpsDataRefusal,
	type OpsDataRefusalReason,
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
import { method } from './bindings.js'
import type { MaintenanceBarrier } from './maintenance.js'
import type { OpsRecovery, OpsTarget } from './ops.js'

/** The KV key of the sentinel. KV, unlike R2, is rewound with the object's SQLite, so its absence proves the restore. */
const SENTINEL_KEY = '__fabrika/restore-sentinel'

const ABORT_REASON = 'fabrika: point-in-time restore armed'

/**
 * One step of the original object's point-in-time restore (ADR-0070 §9 step 6). `prepare` and `arm` run only under
 * the published generation while the object is `inspect`; `verify` writes nothing and runs in any mode.
 */
export async function serveRestore(target: OpsTarget, barrier: MaintenanceBarrier, step: OpsRestoreRequest): Promise<Response> {
	const { recovery } = target
	if (recovery === null) {
		return jsonResponse({ refused: 'not_implemented' }, 501)
	}
	const sentinel = kvSentinel(target.storage)
	switch (step.step) {
		case 'prepare':
			return barrierRefusal(barrier, step.generation) ?? await prepare(recovery, sentinel, step)
		case 'arm':
			return barrierRefusal(barrier, step.generation) ?? await arm(recovery, step)
		case 'verify':
			return await verify(recovery, sentinel, step)
	}
}

/** The target's bookmark first, so a refused time writes nothing; the current one after the sentinel's write. */
async function prepare(recovery: OpsRecovery, sentinel: SentinelStore, step: OpsRestorePrepare): Promise<Response> {
	const at = Date.parse(step.at)
	// A target at or after the sentinel's write would keep it, and `verify` could never see the restore.
	if (at >= Date.now()) {
		return dataRefusal('bookmark_unavailable')
	}
	let target: string
	try {
		target = await recovery.getBookmarkForTime(at)
	} catch {
		return dataRefusal('bookmark_unavailable')
	}
	await sentinel.write(step.sentinel)
	return answer(parseOpsRestorePrepareAck({ step: 'prepare', current: await recovery.getCurrentBookmark(), target }))
}

/** Arms the restore and resets the object once the answer is out; the answer may still be lost, and `verify` decides. */
async function arm(recovery: OpsRecovery, step: OpsRestoreArm): Promise<Response> {
	let undo: string
	try {
		undo = await recovery.onNextSessionRestoreBookmark(step.target)
	} catch {
		return dataRefusal('bookmark_unavailable')
	}
	const response = answer(parseOpsRestoreArmAck({ step: 'arm', undo }))
	setTimeout(() => recovery.abort(ABORT_REASON), 0)
	return response
}

/** Present only when the KV holds this operation's sentinel: a restore to a time before `prepare` removed it. */
async function verify(recovery: OpsRecovery, sentinel: SentinelStore, step: OpsRestoreVerify): Promise<Response> {
	const present = (await sentinel.read()) === step.sentinel
	return answer(parseOpsRestoreVerifyAck({ step: 'verify', sentinel: present ? 'present' : 'absent', bookmark: await recovery.getCurrentBookmark() }))
}

/**
 * ADR-0070 §1 and §9: ADR-0069's stale refusal unless `generation` is the published one, then `wrong_mode` unless
 * `inspect`. A state R2 has not confirmed answers 503, as a failed transition does, and Control retries.
 */
function barrierRefusal(barrier: MaintenanceBarrier, generation: number): Response | null {
	const { mode, generation: current, published } = barrier.view()
	if (current === null) {
		const refusal: OpsStaleRefusal = { refused: 'stale_generation', published: null }
		return jsonResponse(refusal, OPS_STALE_STATUS)
	}
	if (!published) {
		return new Response(null, { status: 503 })
	}
	if (current !== generation) {
		const refusal: OpsStaleRefusal = { refused: 'stale_generation', published: { generation: current, mode } }
		return jsonResponse(refusal, OPS_STALE_STATUS)
	}
	return mode === 'inspect' ? null : dataRefusal('wrong_mode')
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

/** Where the sentinel lives: the object's KV storage. */
interface SentinelStore {
	read(): Promise<string | null>
	write(sentinel: string): Promise<void>
}

/** workerd's `DurableObjectStorage` `get` and `put`, read structurally: the ops seam types only the SQL side. */
function kvSentinel(storage: unknown): SentinelStore {
	const call = (name: string): (...args: unknown[]) => unknown => {
		const found = method(storage, name)
		if (found === null) {
			throw new Error(`the object's storage has no ${name}; a Durable Object's storage has it`)
		}
		return found
	}
	return {
		async read() {
			const value: unknown = await call('get')(SENTINEL_KEY)
			return typeof value === 'string' ? value : null
		},
		async write(sentinel) {
			await call('put')(SENTINEL_KEY, sentinel)
		},
	}
}
