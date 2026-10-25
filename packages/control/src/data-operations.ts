// Control drives a data operation on an application environment's object (ADR-0069 §3): it allocates every
// generation, records each step under the environment's deploy lease, and reaches the object only through the injected
// `OpsTransport`. Control's record is the authority; the object's published state is a copy it reconciles with.

import {
	DEFAULT_APPLICATION_OBJECT,
	OPS_CONTENT_TYPE,
	OPS_DATA_REFUSED_STATUS,
	OPS_DUMP_MAX_PARTS,
	OPS_METHOD,
	OPS_REFUSAL_STATUS,
	OPS_REHEARSAL_OBJECT,
	OPS_STALE_STATUS,
	type OpsContentView,
	type OpsDataRefusal,
	type OpsDumpManifest,
	type OpsDumpTable,
	type OpsExportBeginAck,
	type OpsExportCompleteAck,
	type OpsExportPartAck,
	type OpsExportRequest,
	type OpsImportBeginAck,
	type OpsImportCompleteAck,
	type OpsImportDiscardAck,
	type OpsImportLinkAck,
	type OpsImportPartAck,
	type OpsImportRequest,
	type OpsImportVerifyAck,
	type OpsInspectRequest,
	type OpsMigrateAck,
	type OpsMigrateRequest,
	type OpsMode,
	type OpsOperation,
	opsPath,
	type OpsPublishedState,
	type OpsStateAck,
	type OpsStateRequest,
	type OpsUploadedPart,
	type OpsView,
	parseOpsContentView,
	parseOpsDataRefusal,
	parseOpsExportBeginAck,
	parseOpsExportCompleteAck,
	parseOpsExportPartAck,
	parseOpsImportBeginAck,
	parseOpsImportCompleteAck,
	parseOpsImportDiscardAck,
	parseOpsImportLinkAck,
	parseOpsImportPartAck,
	parseOpsImportVerifyAck,
	parseOpsMigrateAck,
	parseOpsStaleRefusal,
	parseOpsStateAck,
	parseOpsView,
} from '@fabrika/auth-core'
import type { DataOperationDto } from '@fabrika/control-contract'
import { type DeployLocks, uuidv7 } from '@fabrika/platform'
import { isLeaseLoss, ProviderInvocationAbort } from '@fabrika/provider-contract'
import type {
	BackupPartRow,
	BackupRow,
	ControlRegistryRepository,
	ControlRepositories,
	DataOperationAdvance,
	DataOperationInput,
	DataOperationResolution,
	DataOperationRow,
} from './db'
import { acquireLease, type Lease, type LeaseClock, runLeaseKey } from './lease'

/** The environment an ops request goes to. */
export interface OpsTarget {
	readonly appId: string
	readonly env: string
}

/**
 * Why the object gave no answer to act on: the environment has no channel (no domain), a 404 other than the uniform
 * refusal came back, the object could not be reached, answered 5xx or refused every key Control holds, its answer did
 * not parse, or its release does not serve the operation (`not_served`, its 501). Only `unreachable` is worth repeating
 * at once.
 */
export type OpsUnavailable = 'no_channel' | 'channel_refused' | 'unreachable' | 'invalid_answer' | 'not_served'

/** The error code of an operation the object's release does not serve: it changed nothing, so it never settles a mode. */
export const NOT_SERVED_CODE = 'not_served'

/** The view `inspect` returned, in the form its request asked for. */
export type OpsInspection = { readonly content: false; readonly view: OpsView } | { readonly content: true; readonly view: OpsContentView }

export type OpsAnswer<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'unavailable'; readonly reason: OpsUnavailable }

/** A mutating request's answer: also the 409 stale refusal, naming what the object has published. */
export type OpsFencedAnswer<T> = OpsAnswer<T> | { readonly kind: 'stale'; readonly published: OpsPublishedState | null }

/** A dump step's answer: also the 422 refusal, with its reason and the table at fault. */
export type OpsDataAnswer<T> = OpsFencedAnswer<T> | { readonly kind: 'refused'; readonly refusal: OpsDataRefusal }

/** The answer to an export step, parsed by that step's parser. */
export type OpsExportAck = OpsExportBeginAck | OpsExportPartAck | OpsExportCompleteAck

/** The answer to an import step, parsed by that step's parser. */
export type OpsImportAck = OpsImportBeginAck | OpsImportPartAck | OpsImportLinkAck | OpsImportVerifyAck | OpsImportCompleteAck | OpsImportDiscardAck

/** Control's calls to an environment's object; every answer is parsed before it is returned. */
export interface OpsTransport {
	inspect(target: OpsTarget, request: OpsInspectRequest, signal: AbortSignal): Promise<OpsAnswer<OpsInspection>>
	state(target: OpsTarget, request: OpsStateRequest, signal: AbortSignal): Promise<OpsFencedAnswer<OpsStateAck>>
	migrate(target: OpsTarget, request: OpsMigrateRequest, signal: AbortSignal): Promise<OpsFencedAnswer<OpsMigrateAck>>
	export(target: OpsTarget, request: OpsExportRequest, signal: AbortSignal): Promise<OpsDataAnswer<OpsExportAck>>
	import(target: OpsTarget, request: OpsImportRequest, signal: AbortSignal): Promise<OpsDataAnswer<OpsImportAck>>
}

export interface DataOperationDeps {
	repositories: Pick<ControlRepositories, 'dataOperations' | 'backups'>
	lock: DeployLocks
	leaseClock?: LeaseClock
	ops: OpsTransport
	/**
	 * Whether the maintenance pass driving the operation is out of time. Checked before each export and import request;
	 * once it answers true the operation stops `paused`, running at its recorded progress, for a later pass.
	 */
	passSpent?: () => boolean
}

/**
 * Why an operation was not started or advanced: one is still running, the recovery target cannot be recovered, the
 * operation is no longer the environment's newest running one, the record does not leave the environment open (a
 * backup ends by opening it), or the channel.
 */
export type DataOperationRefusal = 'operation_running' | 'not_recoverable' | 'superseded' | 'not_open' | OpsUnavailable

/**
 * `interrupted`: the object gave no answer to act on, so the record keeps running at its step and the environment stays
 * in its last acknowledged mode. `paused`: the pass ran out of time; the record keeps running at its recorded progress.
 * `lease_lost`: the operation stopped without effect at its next check.
 */
export type DriveResult = 'succeeded' | 'failed' | 'interrupted' | 'paused' | 'lease_lost'

/**
 * The codes a backup fails with only once the object acknowledged `open` again, so the environment is open: the dump
 * failed (its reason is on the backup record), or its rehearsal did.
 */
export const BACKUP_FAILED_CODE = 'backup_failed'
export const REHEARSAL_FAILED_CODE = 'rehearsal_failed'
const REOPENED_CODES: ReadonlySet<string | null> = new Set([BACKUP_FAILED_CODE, REHEARSAL_FAILED_CODE])

export type DataOperationOutcome =
	| { readonly kind: 'busy' }
	| { readonly kind: 'refused'; readonly reason: DataOperationRefusal }
	| { readonly kind: 'driven'; readonly result: DriveResult; readonly operation: DataOperationRow }

/** Every ops request names the object of ordinary traffic until a side restore names another. */
const OBJECT = DEFAULT_APPLICATION_OBJECT
/** How often one step repeats a request whose answer was lost, under the same generation. */
const ATTEMPTS = 3
/** One request's bound: a transition drains for 25 s plus a job's 60 s abort grace before it answers. */
const OPS_REQUEST_TIMEOUT_MS = 120_000

export interface StartMaintenanceInput {
	readonly appId: string
	readonly env: string
	readonly mode: OpsMode
	/** An opaque principal id (`runActor`). */
	readonly actor: string
}

/** Put the environment's object into `mode` under a fresh generation, and drive the transition to its acknowledgement. */
export async function startMaintenance(deps: DataOperationDeps, input: StartMaintenanceInput): Promise<DataOperationOutcome> {
	return await underLease(deps, input, async (driver) => {
		const refusal = await refuseStart(deps, driver, input)
		if (refusal !== null) return refusal
		const generation = await deps.repositories.dataOperations.allocateGeneration(input.appId, input.env)
		const created = await driver.create({
			id: uuidv7(),
			appId: input.appId,
			env: input.env,
			kind: 'maintenance',
			step: input.mode === 'open' ? 'open' : 'restrict',
			targetMode: input.mode,
			generation,
			actor: input.actor,
		})
		return await driver.run(created.id, false)
	})
}

export interface StartBackupInput {
	readonly appId: string
	readonly env: string
	/** An opaque principal id (`runActor`), or the schedule's. */
	readonly actor: string
}

/**
 * Take a consistent backup of the environment's object and rehearse it (ADR-0070 §7, §8): `read-only` at a fresh
 * generation, the dump at that generation, `open` at a new one, then the import into `rehearsal`. A backup ends by
 * opening the object, so it starts only on an environment its record leaves open.
 */
export async function startBackup(deps: DataOperationDeps, input: StartBackupInput): Promise<DataOperationOutcome> {
	return await underLease(deps, input, async (driver) => {
		const latest = await latestOperation(deps, input)
		if (latest?.state === 'running') return { kind: 'refused', reason: 'operation_running' }
		if ((await recordedMaintenance(deps, input)) !== 'open') return { kind: 'refused', reason: 'not_open' }
		const probe = await driver.inspect()
		if (probe.kind !== 'ok') return { kind: 'refused', reason: probe.reason }
		const generation = await deps.repositories.dataOperations.allocateGeneration(input.appId, input.env)
		const created = await driver.create({
			id: uuidv7(),
			appId: input.appId,
			env: input.env,
			kind: 'backup',
			step: 'restrict',
			targetMode: 'read-only',
			generation,
			actor: input.actor,
		})
		await driver.backupOf(created)
		return await driver.run(created.id, false)
	})
}

export interface StartRecoveryInput {
	readonly appId: string
	readonly env: string
	/** The stuck operation, of the same environment. */
	readonly operationId: string
	readonly resolution: DataOperationResolution
	readonly actor: string
}

/**
 * Recover an environment whose operation is stuck: under a fresh lease, read the object's published state, fence it in
 * `closed` at a fresh generation, then resume the interrupted operation from its recorded step or open the object.
 */
export async function startRecovery(deps: DataOperationDeps, input: StartRecoveryInput): Promise<DataOperationOutcome> {
	return await underLease(deps, input, async (driver) => {
		const interrupted = await driver.read(input.operationId)
		// Only a running operation can resume; a failed one can still be opened past.
		const recoverable = interrupted !== null && interrupted.app_id === input.appId && interrupted.env === input.env
			&& (interrupted.state === 'running' || (interrupted.state === 'failed' && input.resolution === 'open'))
		if (!recoverable) return { kind: 'refused', reason: 'not_recoverable' }
		const latest = await latestOperation(deps, input)
		if (latest !== null && latest.id !== interrupted.id && latest.state === 'running') return { kind: 'refused', reason: 'operation_running' }
		const generation = await deps.repositories.dataOperations.allocateGeneration(input.appId, input.env)
		const created = await driver.create({
			id: uuidv7(),
			appId: input.appId,
			env: input.env,
			kind: 'recovery',
			step: 'reconcile',
			targetMode: 'closed',
			generation,
			actor: input.actor,
			recovers: { operationId: interrupted.id, resolution: input.resolution },
		})
		return await driver.run(created.id, false)
	})
}

/**
 * Continue a running operation after its holder died (a Control restart): take the lease, fence the object at a
 * generation above every reserved one in the mode the record requires, then carry on from the recorded step. Only the
 * environment's newest operation, still running, advances here; an older one resumes only through its recovery.
 */
export async function advanceDataOperation(deps: DataOperationDeps, operationId: string): Promise<DataOperationOutcome | null> {
	const row = await deps.repositories.dataOperations.get(operationId)
	if (row === null) return null
	const target = { appId: row.app_id, env: row.env }
	return await underLease(deps, target, async (driver) => {
		const current = await driver.read(row.id)
		const latest = await latestOperation(deps, target)
		if (current?.state !== 'running' || latest?.id !== row.id) return { kind: 'refused', reason: 'superseded' }
		return await driver.run(row.id, true)
	})
}

/**
 * The mode Control's record leaves the environment in: `open` with no operation, the newest operation's target once it
 * succeeded, and `unsettled` while it runs or after it failed, when the object may hold any mode it was sent. A backup
 * that failed only after the object acknowledged `open` left it open. An operation the object's release did not serve
 * changed nothing, so the one before it decides.
 */
export async function recordedMaintenance(
	deps: { repositories: Pick<ControlRepositories, 'dataOperations'> },
	target: OpsTarget,
): Promise<OpsMode | 'unsettled'> {
	let before: string | undefined
	for (;;) {
		const page = await deps.repositories.dataOperations.listForEnvironment(target.appId, target.env, {
			...(before === undefined ? {} : { before }),
			limit: RECORDED_PAGE,
		})
		const deciding = page.find((operation) => !(operation.state === 'failed' && operation.error_code === NOT_SERVED_CODE))
		if (deciding?.state === 'succeeded') return deciding.target_mode
		if (deciding !== undefined) return deciding.state === 'failed' && REOPENED_CODES.has(deciding.error_code) ? 'open' : 'unsettled'
		const last = page.at(-1)
		if (last === undefined || page.length < RECORDED_PAGE) return 'open'
		before = last.id
	}
}

/** How many operations `recordedMaintenance` reads at once while it looks past the ones that changed nothing. */
const RECORDED_PAGE = 20

export async function listDataOperations(
	deps: { repositories: Pick<ControlRepositories, 'dataOperations'> },
	target: OpsTarget,
	page: { before?: string; limit: number },
): Promise<DataOperationDto[]> {
	return (await deps.repositories.dataOperations.listForEnvironment(target.appId, target.env, page)).map(toDataOperationDto)
}

/** The record as `data.read` shows it: identifiers, states, codes and timestamps only. */
export function toDataOperationDto(row: DataOperationRow): DataOperationDto {
	return {
		id: row.id,
		appId: row.app_id,
		env: row.env,
		kind: row.kind,
		step: row.step,
		targetMode: row.target_mode,
		generation: row.generation,
		state: row.state,
		errorCode: row.error_code,
		actor: row.actor,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		finishedAt: row.finished_at,
		recoversOperationId: row.recovers_operation_id,
		resolution: row.resolution,
	}
}

async function latestOperation(
	deps: { repositories: Pick<ControlRepositories, 'dataOperations'> },
	target: OpsTarget,
): Promise<DataOperationRow | null> {
	const [latest] = await deps.repositories.dataOperations.listForEnvironment(target.appId, target.env, { limit: 1 })
	return latest ?? null
}

/** A stuck operation is recovered, never overtaken; and an object Control cannot reach gets no record. */
async function refuseStart(deps: DataOperationDeps, driver: OperationDriver, target: OpsTarget): Promise<DataOperationOutcome | null> {
	const latest = await latestOperation(deps, target)
	if (latest?.state === 'running') return { kind: 'refused', reason: 'operation_running' }
	const probe = await driver.inspect()
	return probe.kind === 'ok' ? null : { kind: 'refused', reason: probe.reason }
}

async function underLease(
	deps: DataOperationDeps,
	target: OpsTarget,
	work: (driver: OperationDriver) => Promise<DataOperationOutcome>,
): Promise<DataOperationOutcome> {
	const lease = await acquireLease(deps.lock, runLeaseKey(target.appId, target.env), deps.leaseClock)
	if (lease === null) return { kind: 'busy' }
	try {
		return await work(new OperationDriver(deps, lease, target))
	} catch (error) {
		// Lost before any record was written, the operation never existed.
		if (isLeaseLoss(error)) return { kind: 'busy' }
		throw error
	} finally {
		await lease.release()
	}
}

type Published =
	| { readonly kind: 'acked'; readonly row: DataOperationRow }
	| { readonly kind: 'refused'; readonly code: string }
	| { readonly kind: 'interrupted' }

type Step = { readonly kind: 'next'; readonly row: DataOperationRow } | { readonly kind: 'done'; readonly result: Exclude<DriveResult, 'lease_lost'> }

/** Why a dump or rehearsal step stopped short of its answer: a code to fail with, the pass's end, or no answer to act on. */
type DataStop = { readonly kind: 'failed'; readonly code: string } | { readonly kind: 'paused' } | { readonly kind: 'interrupted' }

type DataResult<T> = { readonly kind: 'ok'; readonly value: T } | DataStop

/** One holder's run of an operation. Every write is fenced on its lease, and each request goes out only while it holds it. */
class OperationDriver {
	/** What this holder saw each object acknowledge, so a step after a successor's fence does not publish it twice. */
	private readonly acknowledged = new Map<string, OpsPublishedState>()

	constructor(private readonly deps: DataOperationDeps, private readonly lease: Lease, private readonly target: OpsTarget) {}

	private get records() {
		return this.deps.repositories.dataOperations
	}

	private get backups() {
		return this.deps.repositories.backups
	}

	async read(id: string): Promise<DataOperationRow | null> {
		const row = await this.records.get(id)
		this.lease.assertHeld()
		return row
	}

	async create(input: DataOperationInput): Promise<DataOperationRow> {
		const created = await this.records.create(input, this.lease.fence())
		if (created !== null) return created
		// `create` records nothing only when the fence no longer holds the environment's lease.
		this.lease.abandon()
		throw new ProviderInvocationAbort('lease_lost')
	}

	/** The backup `operation` takes, recorded with a fresh dump id the first time it is asked for. */
	async backupOf(operation: DataOperationRow): Promise<BackupRow> {
		const found = await this.backups.getForOperation(operation.id)
		this.lease.assertHeld()
		if (found !== null) return found
		const created = await this.backups.create(
			{ id: uuidv7(), appId: operation.app_id, env: operation.env, operationId: operation.id, object: OBJECT },
			this.lease.fence(),
		)
		if (created !== null) return created
		this.lease.abandon()
		throw new ProviderInvocationAbort('lease_lost')
	}

	async inspect(): Promise<OpsAnswer<OpsInspection>> {
		this.lease.assertHeld()
		const answer = await this.deps.ops.inspect(this.target, { object: OBJECT, content: false }, this.lease.signal)
		this.lease.assertHeld()
		return answer
	}

	/** Drive `id` to its end or to the first step the object leaves unanswered. */
	async run(id: string, successor: boolean): Promise<DataOperationOutcome> {
		let result: DriveResult
		try {
			result = await this.drive(id, successor)
		} catch (error) {
			if (!isLeaseLoss(error)) throw error
			result = 'lease_lost'
		}
		const operation = await this.records.get(id)
		if (operation === null) throw new Error('a data operation vanished')
		return { kind: 'driven', result, operation }
	}

	private async drive(id: string, successor: boolean): Promise<Exclude<DriveResult, 'lease_lost'>> {
		let row = await this.require(id)
		if (row.state !== 'running') return row.state
		// A successor first fences out every request its predecessor sent; a recovery that has not reconciled sent none.
		if (successor && row.step !== 'reconcile') {
			row = await this.advance(row, { step: row.step, generation: await this.allocate() })
			const fenced = await this.publish(row, row.target_mode)
			if (fenced.kind === 'refused') return (await this.failed(row, fenced.code)).result
			if (fenced.kind !== 'acked') return fenced.kind
			row = fenced.row
		}
		for (;;) {
			const step = await this.step(row)
			if (step.kind === 'done') return step.result
			row = step.row
		}
	}

	private async step(row: DataOperationRow): Promise<Step> {
		if (row.kind === 'maintenance' && (row.step === 'restrict' || row.step === 'open')) {
			const published = await this.publish(row, row.target_mode)
			if (published.kind === 'refused') return await this.failed(row, published.code)
			if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
			await this.finish(published.row)
			return { kind: 'done', result: 'succeeded' }
		}
		if (row.kind === 'recovery') return await this.recoveryStep(row)
		if (row.kind === 'backup') return await this.backupStep(row)
		throw new Error(`data operation step ${row.kind}/${row.step} is not driven by this release`)
	}

	private async recoveryStep(row: DataOperationRow): Promise<Step> {
		const interruptedId = row.recovers_operation_id
		if (interruptedId === null || row.resolution === null) throw new Error('a recovery names no operation')
		switch (row.step) {
			case 'reconcile': {
				const probe = await this.inspect()
				if (probe.kind !== 'ok') return { kind: 'done', result: 'interrupted' }
				return { kind: 'next', row: await this.advance(row, { step: 'restrict' }) }
			}
			case 'restrict': {
				const fenced = await this.publish(row, 'closed')
				if (fenced.kind === 'refused') return await this.failed(row, fenced.code)
				if (fenced.kind !== 'acked') return { kind: 'done', result: fenced.kind }
				if (row.resolution === 'open') {
					return { kind: 'next', row: await this.advance(fenced.row, { step: 'open', targetMode: 'open', generation: await this.allocate() }) }
				}
				const interrupted = await this.require(interruptedId)
				return { kind: 'next', row: await this.advance(fenced.row, { step: 'resume', targetMode: interrupted.target_mode }) }
			}
			case 'open': {
				const published = await this.publish(row, 'open')
				if (published.kind === 'refused') return await this.failed(row, published.code)
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				await this.retireChain(row, 'recovered_open')
				await this.finish(published.row)
				return { kind: 'done', result: 'succeeded' }
			}
			case 'resume': {
				const resumed = await this.drive(interruptedId, true)
				if (resumed === 'interrupted' || resumed === 'paused') return { kind: 'done', result: resumed }
				if (resumed === 'failed') return await this.failed(row, 'resume_failed')
				// The recovery is now the newest record, so it carries the mode the resumed operation left the object in.
				const interrupted = await this.require(interruptedId)
				const settled = await this.advance(row, { step: 'resume', targetMode: interrupted.target_mode })
				await this.retireChain(row, 'superseded')
				await this.finish(settled)
				return { kind: 'done', result: 'succeeded' }
			}
			default:
				throw new Error(`a recovery has no step ${row.step}`)
		}
	}

	/**
	 * A backup: `restrict` publishes `read-only`; `backup` takes the dump at that generation; `open` publishes a new one,
	 * and fails the operation when the dump failed; `verify` rehearses the dump in `rehearsal`. The backup record holds
	 * each step's progress, so a successor carries on from it: a dump never restarts, and only one is ever recorded.
	 */
	private async backupStep(row: DataOperationRow): Promise<Step> {
		const backup = await this.backupOf(row)
		switch (row.step) {
			case 'restrict': {
				const published = await this.publish(row, 'read-only')
				if (published.kind === 'refused') {
					this.lease.assertWritten(await this.backups.fail(backup.id, published.code, this.lease.fence()))
					return await this.failed(row, published.code)
				}
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				return { kind: 'next', row: await this.advance(published.row, { step: 'backup' }) }
			}
			case 'backup': {
				const dumped = await this.dump(row, backup)
				if (dumped.kind === 'paused' || dumped.kind === 'interrupted') return { kind: 'done', result: dumped.kind }
				// A failed dump still reopens the object before the operation fails.
				if (dumped.kind === 'failed') this.lease.assertWritten(await this.backups.fail(backup.id, dumped.code, this.lease.fence()))
				return { kind: 'next', row: await this.advance(row, { step: 'open', targetMode: 'open', generation: await this.allocate() }) }
			}
			case 'open': {
				const published = await this.publish(row, 'open')
				if (published.kind === 'refused') {
					if (backup.state === 'running') this.lease.assertWritten(await this.backups.fail(backup.id, published.code, this.lease.fence()))
					return await this.failed(row, published.code)
				}
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				if (backup.state === 'failed') {
					// A release that does not serve the dump changed nothing the object kept: the operation before decides.
					return await this.failed(published.row, backup.error_code === NOT_SERVED_CODE ? NOT_SERVED_CODE : BACKUP_FAILED_CODE)
				}
				return { kind: 'next', row: await this.advance(published.row, { step: 'verify', generation: await this.allocate() }) }
			}
			case 'verify': {
				const rehearsed = await this.rehearse(row, backup)
				if (rehearsed.kind === 'paused' || rehearsed.kind === 'interrupted') return { kind: 'done', result: rehearsed.kind }
				if (rehearsed.kind === 'failed') {
					this.lease.assertWritten(await this.backups.rehearsalFailed(backup.id, rehearsed.code, this.lease.fence()))
					return await this.failed(row, REHEARSAL_FAILED_CODE)
				}
				this.lease.assertWritten(await this.backups.succeed(backup.id, this.lease.fence()))
				await this.finish(row)
				return { kind: 'done', result: 'succeeded' }
			}
			default:
				throw new Error(`a backup has no step ${row.step}`)
		}
	}

	/**
	 * The consistent dump (ADR-0070 §2), from the progress the record holds: `begin` once, each part from the cursor the
	 * last recorded part answered, then `complete` with the recorded parts and tables, whose manifest must describe them.
	 */
	private async dump(row: DataOperationRow, start: BackupRow): Promise<DataResult<null>> {
		let backup = start
		const scope = { object: backup.object, generation: row.generation, consistent: true, dump: backup.id }
		if (backup.upload_id === null || backup.bookmark === null) {
			const begun = await this.exportStep({ ...scope, step: 'begin' })
			if (begun.kind !== 'ok') return begun
			if (begun.value.step !== 'begin') return invalidAnswer()
			this.lease.assertWritten(await this.backups.begun(backup.id, begun.value, this.lease.fence()))
			backup = await this.requireBackup(backup.id)
		}
		const { upload_id: uploadId, bookmark } = backup
		if (uploadId === null || bookmark === null) throw new Error('a begun backup lost its upload')
		const parts = (await this.backups.parts(backup.id)).map(recordedPart)
		let last = parts.at(-1)
		while (last === undefined || last.next !== null) {
			if (parts.length >= OPS_DUMP_MAX_PARTS) return { kind: 'failed', code: 'too_many_parts' }
			const part = parts.length + 1
			const answer = await this.exportStep({ ...scope, step: 'part', uploadId, part, cursor: last?.next ?? null })
			if (answer.kind !== 'ok') return answer
			if (answer.value.step !== 'part' || answer.value.uploaded.part !== part) return invalidAnswer()
			this.lease.assertWritten(await this.backups.addPart(backup.id, part, JSON.stringify(answer.value), this.lease.fence()))
			parts.push(answer.value)
			last = answer.value
		}
		const uploaded = parts.map((recorded) => recorded.uploaded)
		const tables = parts.flatMap((recorded) => recorded.tables)
		const completed = await this.exportStep({ ...scope, step: 'complete', uploadId, bookmark, parts: uploaded, tables })
		if (completed.kind !== 'ok') return completed
		if (completed.value.step !== 'complete' || !describes(completed.value.manifest, backup, bookmark, uploaded, tables)) return invalidAnswer()
		const sizeBytes = uploaded.reduce((sum, part) => sum + part.size, 0)
		this.lease.assertWritten(
			await this.backups.completed(backup.id, { sizeBytes, parts: uploaded.length, tables: completed.value.manifest.tables.length }, this.lease.fence()),
		)
		return { kind: 'ok', value: null }
	}

	/**
	 * The rehearsal (ADR-0070 §7): fence `rehearsal` in `inspect` at the record's generation, then import the dump from
	 * the progress the record holds. A target that is not fresh is discarded once before `begin` is sent again. Every
	 * part is loaded, the parts with deferred rows are linked, the tables are verified to the end, and the target is
	 * discarded. `complete` is not sent: it clears the import marker, and `discard` wipes only a target that holds one.
	 */
	private async rehearse(start: DataOperationRow, initial: BackupRow): Promise<DataResult<null>> {
		const fenced = await this.publish(start, 'inspect', OPS_REHEARSAL_OBJECT)
		if (fenced.kind === 'refused') return { kind: 'failed', code: fenced.code }
		if (fenced.kind !== 'acked') return fenced
		const generation = fenced.row.generation
		const source = { object: initial.object, dump: initial.id }
		const scope = { object: OPS_REHEARSAL_OBJECT, generation, source }
		const discard = { step: 'discard', object: OPS_REHEARSAL_OBJECT, generation } as const
		let backup = initial
		let parts: BackupPartRow[] = await this.backups.parts(backup.id)
		let discarded = false
		for (;;) {
			switch (backup.rehearsal_step) {
				case null: {
					const begun = await this.importStep({ ...scope, step: 'begin' })
					if (begun.kind === 'failed' && begun.code === 'not_fresh' && !discarded) {
						const wiped = await this.importStep(discard)
						if (wiped.kind !== 'ok') return wiped
						discarded = true
						continue
					}
					if (begun.kind !== 'ok') return begun
					if (begun.value.step !== 'begin' || begun.value.parts !== backup.parts) return invalidAnswer()
					this.lease.assertWritten(await this.backups.rehearse(backup.id, { step: 'part', parts: begun.value.parts }, this.lease.fence()))
					break
				}
				case 'part': {
					const next = parts.find((part) => part.deferred === null)
					if (next === undefined) {
						this.lease.assertWritten(await this.backups.rehearse(backup.id, { step: 'link' }, this.lease.fence()))
						break
					}
					const loaded = await this.importStep({ ...scope, step: 'part', part: next.part })
					if (loaded.kind !== 'ok') return loaded
					if (loaded.value.step !== 'part' || loaded.value.part !== next.part) return invalidAnswer()
					const { deferred } = loaded.value
					this.lease.assertWritten(await this.backups.partLoaded(backup.id, next.part, deferred, this.lease.fence()))
					parts = parts.map((part) => part.part === next.part ? { ...part, deferred } : part)
					continue
				}
				case 'link': {
					const next = parts.find((part) => (part.deferred ?? 0) > 0 && part.linked === 0)
					if (next === undefined) {
						this.lease.assertWritten(await this.backups.rehearse(backup.id, { step: 'verify' }, this.lease.fence()))
						break
					}
					const linked = await this.importStep({ ...scope, step: 'link', part: next.part })
					if (linked.kind !== 'ok') return linked
					if (linked.value.step !== 'link' || linked.value.part !== next.part) return invalidAnswer()
					this.lease.assertWritten(await this.backups.partLinked(backup.id, next.part, this.lease.fence()))
					parts = parts.map((part) => part.part === next.part ? { ...part, linked: 1 } : part)
					continue
				}
				case 'verify': {
					const cursor = backup.rehearsal_cursor === null ? null : recordedVerify(backup.rehearsal_cursor).next
					const verified = await this.importStep({ ...scope, step: 'verify', cursor })
					if (verified.kind !== 'ok') return verified
					if (verified.value.step !== 'verify') return invalidAnswer()
					const step = verified.value.next === null ? 'discard' : 'verify'
					this.lease.assertWritten(await this.backups.rehearse(backup.id, { step, cursor: JSON.stringify(verified.value) }, this.lease.fence()))
					break
				}
				case 'discard': {
					const wiped = await this.importStep(discard)
					// A discard whose answer was lost already removed the marker its retry looks for.
					if (wiped.kind === 'failed' && wiped.code === 'no_import') return { kind: 'ok', value: null }
					if (wiped.kind !== 'ok') return wiped
					return wiped.value.step === 'discard' ? { kind: 'ok', value: null } : invalidAnswer()
				}
			}
			backup = await this.requireBackup(backup.id)
		}
	}

	private async exportStep(request: OpsExportRequest): Promise<DataResult<OpsExportAck>> {
		return await this.dataStep((signal) => this.deps.ops.export(this.target, request, signal))
	}

	private async importStep(request: OpsImportRequest): Promise<DataResult<OpsImportAck>> {
		return await this.dataStep((signal) => this.deps.ops.import(this.target, request, signal))
	}

	/**
	 * One dump or import request, sent only while the pass has time and the lease holds. A lost answer repeats it, which
	 * every step tolerates. A refusal, a stale generation and any other unusable answer fail it with a code.
	 */
	private async dataStep<T>(send: (signal: AbortSignal) => Promise<OpsDataAnswer<T>>): Promise<DataResult<T>> {
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			if (this.deps.passSpent?.() === true) return { kind: 'paused' }
			this.lease.assertHeld()
			const answer = await send(this.lease.signal)
			this.lease.assertHeld()
			if (answer.kind === 'ok') return answer
			if (answer.kind === 'refused') return { kind: 'failed', code: answer.refusal.refused }
			if (answer.kind === 'stale') return { kind: 'failed', code: 'stale_generation' }
			if (answer.reason !== 'unreachable') return { kind: 'failed', code: answer.reason }
		}
		return { kind: 'interrupted' }
	}

	/**
	 * Publish `mode` to `object` at the record's generation. A lost answer repeats the same generation and mode, which the
	 * object treats as a retry. A stale refusal naming a higher generation is adopted once: the fenced write of a fresh
	 * generation proves the lease is still this holder's, or aborts it, and the transition is sent again. Any other stale
	 * refusal, and the 501 of a release that does not serve the transition, are refused with a code for the caller to
	 * fail with.
	 */
	private async publish(start: DataOperationRow, mode: OpsMode, object: string = OBJECT): Promise<Published> {
		let row = start
		let adopted = false
		let attempts = 0
		while (attempts < ATTEMPTS) {
			const acknowledged = this.acknowledged.get(object)
			if (acknowledged?.generation === row.generation && acknowledged.mode === mode) return { kind: 'acked', row }
			this.lease.assertHeld()
			const answer = await this.deps.ops.state(this.target, { object, generation: row.generation, mode }, this.lease.signal)
			this.lease.assertHeld()
			if (answer.kind === 'ok') {
				if (answer.value.generation !== row.generation || answer.value.mode !== mode) return { kind: 'interrupted' }
				this.acknowledged.set(object, { generation: row.generation, mode })
				return { kind: 'acked', row }
			}
			if (answer.kind === 'stale') {
				if (adopted || answer.published === null || answer.published.generation <= row.generation) return { kind: 'refused', code: 'stale_generation' }
				adopted = true
				row = await this.advance(row, { step: row.step, generation: await this.allocate() })
				continue
			}
			// The release never applied the transition: a running record would refuse every deploy.
			if (answer.reason === 'not_served') return { kind: 'refused', code: NOT_SERVED_CODE }
			if (answer.reason !== 'unreachable') return { kind: 'interrupted' }
			attempts++
		}
		return { kind: 'interrupted' }
	}

	/**
	 * Retire every operation still running in the chain `recovery` recovers, through each recovery it names, so no older
	 * operation can later publish over the mode this recovery leaves. Each write is fenced on this holder's lease, and the
	 * recovery finishes only after them, so a successor that finds it unfinished retires the rest.
	 */
	private async retireChain(recovery: DataOperationRow, code: string): Promise<void> {
		const seen = new Set<string>([recovery.id])
		let next = recovery.recovers_operation_id
		while (next !== null && !seen.has(next)) {
			seen.add(next)
			const operation = await this.require(next)
			if (operation.state === 'running') await this.fail(operation, code)
			next = operation.recovers_operation_id
		}
	}

	private async require(id: string): Promise<DataOperationRow> {
		const row = await this.read(id)
		if (row === null) throw new Error('a data operation vanished')
		return row
	}

	private async requireBackup(id: string): Promise<BackupRow> {
		const row = await this.backups.get(id)
		this.lease.assertHeld()
		if (row === null) throw new Error('a backup vanished')
		return row
	}

	private async allocate(): Promise<number> {
		this.lease.assertHeld()
		return await this.records.allocateGeneration(this.target.appId, this.target.env)
	}

	private async advance(row: DataOperationRow, change: Omit<DataOperationAdvance, 'expectedStep'>): Promise<DataOperationRow> {
		// Under this holder's lease nobody else moves the step, so a refused write means the lease is gone.
		this.lease.assertWritten(await this.records.advance(row.id, { expectedStep: row.step, ...change }, this.lease.fence()))
		return await this.require(row.id)
	}

	private async finish(row: DataOperationRow): Promise<void> {
		this.lease.assertWritten(await this.records.finish(row.id, this.lease.fence()))
	}

	private async fail(row: DataOperationRow, code: string): Promise<void> {
		this.lease.assertWritten(await this.records.fail(row.id, code, this.lease.fence()))
	}

	private async failed(row: DataOperationRow, code: string): Promise<{ readonly kind: 'done'; readonly result: 'failed' }> {
		await this.fail(row, code)
		return { kind: 'done', result: 'failed' }
	}
}

function invalidAnswer(): DataStop {
	return { kind: 'failed', code: 'invalid_answer' }
}

/** Whether a complete answer's manifest is the dump Control recorded: its id, source, bookmark, parts and tables. */
function describes(
	manifest: OpsDumpManifest,
	backup: BackupRow,
	bookmark: string,
	parts: readonly OpsUploadedPart[],
	tables: readonly OpsDumpTable[],
): boolean {
	const sameParts = manifest.parts.length === parts.length && manifest.parts.every((part, index) => {
		const recorded = parts.at(index)
		return recorded !== undefined && part.part === recorded.part && part.size === recorded.size && part.sha256 === recorded.sha256
	})
	const sameTables = manifest.tables.length === tables.length && manifest.tables.every((table, index) => {
		const recorded = tables.at(index)
		return recorded !== undefined && table.name === recorded.name && table.rows === recorded.rows && table.hash === recorded.hash
	})
	return manifest.dump === backup.id && manifest.object === backup.object && manifest.consistent && manifest.bookmark === bookmark && sameParts
		&& sameTables
}

/** A recorded part's answer, read again with the wire's parser: Control wrote it, so one that does not parse is a fault. */
function recordedPart(row: BackupPartRow): OpsExportPartAck {
	const ack = parseOpsExportPartAck(parseRecorded(row.ack))
	if (ack === null) throw new Error('a recorded backup part does not parse')
	return ack
}

function recordedVerify(text: string): OpsImportVerifyAck {
	const ack = parseOpsImportVerifyAck(parseRecorded(text))
	if (ack === null) throw new Error("a recorded rehearsal's verify answer does not parse")
	return ack
}

function parseRecorded(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

export interface HttpOpsTransportDeps {
	registry: Pick<ControlRegistryRepository, 'getAppEnv'>
	/** The plaintext ops keys to try, newest first, at most two; empty while none is issued. Never logged. */
	opsKeysFor(appId: string, env: string): Promise<readonly string[]>
	fetch?: (input: string, init: RequestInit) => Promise<Response>
}

/** The ops channel over HTTPS: `POST https://<environment domain>/__fabrika/ops/<operation>` with the ops key. */
export function httpOpsTransport(deps: HttpOpsTransportDeps): OpsTransport {
	const send = deps.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))

	async function call(
		target: OpsTarget,
		operation: OpsOperation,
		body: OpsRequest,
		signal: AbortSignal,
	): Promise<{ readonly status: number; readonly body: unknown } | OpsUnavailable> {
		const row = await deps.registry.getAppEnv(target.appId, target.env)
		const origin = row === null ? null : channelOrigin(row.domain)
		if (origin === null) return 'no_channel'
		// While a rotation reconciles the running version accepts either key; its uniform refusal moves on to the next.
		for (const key of await deps.opsKeysFor(target.appId, target.env)) {
			const answer = await attempt(origin, operation, body, key, signal)
			if (answer !== 'refused') return answer
		}
		return 'unreachable'
	}

	async function attempt(
		origin: string,
		operation: OpsOperation,
		body: OpsRequest,
		key: string,
		signal: AbortSignal,
	): Promise<{ readonly status: number; readonly body: unknown } | OpsUnavailable | 'refused'> {
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(OPS_REQUEST_TIMEOUT_MS)])
		try {
			// No redirect is followed: the key goes to the environment's own domain and nowhere else.
			const response = await send(`${origin}${opsPath(operation)}`, {
				method: OPS_METHOD,
				headers: { authorization: `Bearer ${key}`, 'content-type': OPS_CONTENT_TYPE },
				body: JSON.stringify(body),
				redirect: 'manual',
				signal: bounded,
			})
			const text = await response.text()
			if (response.status === OPS_REFUSAL_STATUS) return text === '' ? 'refused' : 'channel_refused'
			if (response.status === NOT_IMPLEMENTED_STATUS && notImplemented(text)) return 'not_served'
			if (response.status >= 500) return 'unreachable'
			if (response.status !== 200 && response.status !== OPS_STALE_STATUS && response.status !== OPS_DATA_REFUSED_STATUS) return 'invalid_answer'
			try {
				return { status: response.status, body: JSON.parse(text) }
			} catch {
				return 'invalid_answer'
			}
		} catch {
			// The error is dropped whole: nothing that may carry the request, and so the key, leaves here.
			signal.throwIfAborted()
			return 'unreachable'
		}
	}

	async function fenced<T>(
		target: OpsTarget,
		operation: 'state' | 'migrate',
		body: OpsStateRequest | OpsMigrateRequest,
		signal: AbortSignal,
		parse: (body: unknown) => T | null,
	): Promise<OpsFencedAnswer<T>> {
		const answer = await call(target, operation, body, signal)
		if (typeof answer === 'string') return { kind: 'unavailable', reason: answer }
		// Only a dump step is refused with a reason.
		if (answer.status === OPS_DATA_REFUSED_STATUS) return { kind: 'unavailable', reason: 'invalid_answer' }
		return settled(answer, parse)
	}

	async function data<T>(
		target: OpsTarget,
		operation: 'export' | 'import',
		body: OpsExportRequest | OpsImportRequest,
		signal: AbortSignal,
		parse: (body: unknown) => T | null,
	): Promise<OpsDataAnswer<T>> {
		const answer = await call(target, operation, body, signal)
		if (typeof answer === 'string') return { kind: 'unavailable', reason: answer }
		if (answer.status === OPS_DATA_REFUSED_STATUS) {
			const refusal = parseOpsDataRefusal(answer.body)
			return refusal === null ? { kind: 'unavailable', reason: 'invalid_answer' } : { kind: 'refused', refusal }
		}
		return settled(answer, parse)
	}

	return {
		async inspect(target, request, signal) {
			const answer = await call(target, 'inspect', request, signal)
			if (typeof answer === 'string') return { kind: 'unavailable', reason: answer }
			if (answer.status !== 200) return { kind: 'unavailable', reason: 'invalid_answer' }
			const inspection: OpsInspection | null = request.content
				? nullable(parseOpsContentView(answer.body), (view) => ({ content: true, view }))
				: nullable(parseOpsView(answer.body), (view) => ({ content: false, view }))
			return inspection === null ? { kind: 'unavailable', reason: 'invalid_answer' } : { kind: 'ok', value: inspection }
		},
		state: (target, request, signal) => fenced(target, 'state', request, signal, parseOpsStateAck),
		migrate: (target, request, signal) => fenced(target, 'migrate', request, signal, parseOpsMigrateAck),
		export: (target, request, signal) => data(target, 'export', request, signal, (body) => parseExportAck(request, body)),
		import: (target, request, signal) => data(target, 'import', request, signal, (body) => parseImportAck(request, body)),
	}
}

type OpsRequest = OpsInspectRequest | OpsStateRequest | OpsMigrateRequest | OpsExportRequest | OpsImportRequest

/** A 200 or a 409 of a mutating request, parsed: the stale refusal names what the object published. */
function settled<T>(answer: { readonly status: number; readonly body: unknown }, parse: (body: unknown) => T | null): OpsFencedAnswer<T> {
	if (answer.status === OPS_STALE_STATUS) {
		const refusal = parseOpsStaleRefusal(answer.body)
		return refusal === null ? { kind: 'unavailable', reason: 'invalid_answer' } : { kind: 'stale', published: refusal.published }
	}
	const value = parse(answer.body)
	return value === null ? { kind: 'unavailable', reason: 'invalid_answer' } : { kind: 'ok', value }
}

/** The answer to an export step, by the parser of the step it answers. */
function parseExportAck(request: OpsExportRequest, body: unknown): OpsExportAck | null {
	switch (request.step) {
		case 'begin':
			return parseOpsExportBeginAck(body)
		case 'part':
			return parseOpsExportPartAck(body)
		case 'complete':
			return parseOpsExportCompleteAck(body)
	}
}

/** The answer to an import step, by the parser of the step it answers. */
function parseImportAck(request: OpsImportRequest, body: unknown): OpsImportAck | null {
	switch (request.step) {
		case 'begin':
			return parseOpsImportBeginAck(body)
		case 'part':
			return parseOpsImportPartAck(body)
		case 'link':
			return parseOpsImportLinkAck(body)
		case 'verify':
			return parseOpsImportVerifyAck(body)
		case 'complete':
			return parseOpsImportCompleteAck(body)
		case 'discard':
			return parseOpsImportDiscardAck(body)
	}
}

/** The status of a release's object that serves the channel but not the operation: `{ refused: 'not_implemented' }`. */
const NOT_IMPLEMENTED_STATUS = 501

function notImplemented(text: string): boolean {
	try {
		const body: unknown = JSON.parse(text)
		return typeof body === 'object' && body !== null && Object.keys(body).length === 1 && Reflect.get(body, 'refused') === 'not_implemented'
	} catch {
		return false
	}
}

/** `https://<domain>` for a stored domain that is a bare host, else `null`: a stored record is parsed before use. */
function channelOrigin(domain: string | null): string | null {
	if (domain === null) return null
	try {
		const url = new URL(`https://${domain}`)
		return url.host === domain && url.pathname === '/' ? url.origin : null
	} catch {
		return null
	}
}

function nullable<T, R>(value: T | null, map: (value: T) => R): R | null {
	return value === null ? null : map(value)
}
