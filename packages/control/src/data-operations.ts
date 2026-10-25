// Control drives a data operation on an application environment's object (ADR-0069 §3): it allocates every
// generation, records each step under the environment's deploy lease, and reaches the object only through the injected
// `OpsTransport`. Control's record is the authority; the object's published state is a copy it reconciles with.

import {
	type ApplicationObjects,
	DEFAULT_APPLICATION_OBJECT,
	MAX_APPLICATION_OBJECTS,
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
	type OpsMigration,
	type OpsMode,
	type OpsOperation,
	opsPath,
	type OpsPublishedState,
	type OpsRestoreArmAck,
	type OpsRestorePrepareAck,
	type OpsRestoreRequest,
	type OpsRestoreVerifyAck,
	type OpsStateAck,
	type OpsStateRequest,
	type OpsUploadedPart,
	type OpsView,
	parseApplicationObjects,
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
	parseOpsRestoreArmAck,
	parseOpsRestorePrepareAck,
	parseOpsRestoreVerifyAck,
	parseOpsStaleRefusal,
	parseOpsStateAck,
	parseOpsView,
} from '@fabrika/auth-core'
import type { DataOperationDto } from '@fabrika/control-contract'
import { type DeployLocks, uuidv7 } from '@fabrika/platform'
import { abortableWait, isLeaseLoss, ProviderInvocationAbort } from '@fabrika/provider-contract'
import type {
	BackupCheckpoint,
	BackupPartRow,
	BackupRow,
	ControlRegistryRepository,
	ControlRepositories,
	DataOperationAdvance,
	DataOperationInput,
	DataOperationResolution,
	DataOperationRow,
	RestoreDeploy,
	RestoreRow,
	RunRow,
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

/** The answer to a restore step, parsed by that step's parser. */
export type OpsRestoreAck = OpsRestorePrepareAck | OpsRestoreArmAck | OpsRestoreVerifyAck

/** Control's calls to an environment's object; every answer is parsed before it is returned. */
export interface OpsTransport {
	inspect(target: OpsTarget, request: OpsInspectRequest, signal: AbortSignal): Promise<OpsAnswer<OpsInspection>>
	state(target: OpsTarget, request: OpsStateRequest, signal: AbortSignal): Promise<OpsFencedAnswer<OpsStateAck>>
	migrate(target: OpsTarget, request: OpsMigrateRequest, signal: AbortSignal): Promise<OpsFencedAnswer<OpsMigrateAck>>
	export(target: OpsTarget, request: OpsExportRequest, signal: AbortSignal): Promise<OpsDataAnswer<OpsExportAck>>
	import(target: OpsTarget, request: OpsImportRequest, signal: AbortSignal): Promise<OpsDataAnswer<OpsImportAck>>
	restore(target: OpsTarget, request: OpsRestoreRequest, signal: AbortSignal): Promise<OpsDataAnswer<OpsRestoreAck>>
}

/**
 * The deploys a restore runs itself under its lease (ADR-0070 §9): each redeploys what the environment runs now, with the
 * pointer the step names. Only a composition that can deploy hands it.
 */
export interface OperationDeploys {
	/** Whether the environment has a domain and its approved release is one the provider serves the ops channel at. */
	servesOps(target: OpsTarget): Promise<boolean>
	/** Runs the pending run `runId` under `lease` with `objects` as its pointer, and settles it as far as it can. */
	run(lease: Lease, runId: string, objects: ApplicationObjects): Promise<void>
}

export interface DataOperationDeps {
	repositories: Pick<ControlRepositories, 'dataOperations' | 'backups' | 'runs' | 'applicationObjects' | 'restores'>
	lock: DeployLocks
	leaseClock?: LeaseClock
	ops: OpsTransport
	/** A restore's own deploys; without them a restore does not start, and one resumed at a deploy stays interrupted. */
	deploys?: OperationDeploys
	/** The wait between a restore's `arm` and its `verify`, and before it inspects the clone; real time by default. */
	wait?: (ms: number, signal: AbortSignal) => Promise<void>
	/**
	 * Whether the maintenance pass driving the operation is out of time. Checked before each export and import request;
	 * once it answers true the operation stops `paused`, running at its recorded progress, for a later pass.
	 */
	passSpent?: () => boolean
}

/**
 * Why an operation was not started or advanced: one is still running, the recovery target cannot be recovered, the
 * operation is no longer the environment's newest running one, the record does not leave the environment open (a
 * backup ends by opening it), or the channel. A restore also needs a free name in the object list, a succeeded deploy
 * to redeploy, a composition that deploys, and a target time before now.
 */
export type DataOperationRefusal =
	| 'operation_running'
	| 'not_recoverable'
	| 'superseded'
	| 'not_open'
	| 'too_many_objects'
	| 'nothing_deployed'
	| 'no_deploys'
	| 'not_past'
	| OpsUnavailable

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
/** A migration's run ended before any provider accepted it, so nothing was deployed and the object was opened again. */
export const DEPLOY_NOT_STARTED_CODE = 'deploy_not_started'

/**
 * The codes a restore fails with while its environment's serving object is open: before anything was frozen (the listing
 * deploy failed), once the original is open again (the import, the promotion, the pointer deploy failed, or the clone
 * did not boot and traffic went back), or once the clone serves (the rewind was refused or its schema is not the
 * expected one, and the original stays `inspect` for an operator).
 */
export const LIST_FAILED_CODE = 'list_failed'
export const IMPORT_FAILED_CODE = 'import_failed'
export const PROMOTE_FAILED_CODE = 'promote_failed'
export const POINT_FAILED_CODE = 'point_failed'
export const CLONE_NOT_SERVING_CODE = 'clone_not_serving'
export const BOOKMARK_UNAVAILABLE_CODE = 'bookmark_unavailable'
export const REWIND_FAILED_CODE = 'rewind_failed'
export const UNEXPECTED_SCHEMA_CODE = 'unexpected_schema'
/** The pointer deploy back to the original failed: neither object serves, for an operator to recover. */
export const REVERT_FAILED_CODE = 'revert_failed'

const REOPENED_CODES: ReadonlySet<string | null> = new Set([
	BACKUP_FAILED_CODE,
	REHEARSAL_FAILED_CODE,
	DEPLOY_NOT_STARTED_CODE,
	LIST_FAILED_CODE,
	IMPORT_FAILED_CODE,
	PROMOTE_FAILED_CODE,
	POINT_FAILED_CODE,
	CLONE_NOT_SERVING_CODE,
	BOOKMARK_UNAVAILABLE_CODE,
	REWIND_FAILED_CODE,
	UNEXPECTED_SCHEMA_CODE,
])

/** The failures after which the clone may have been published `open`, so traffic going back to the original fences it first. */
const CLONE_OPENED_CODES: ReadonlySet<string | null> = new Set([PROMOTE_FAILED_CODE, POINT_FAILED_CODE, CLONE_NOT_SERVING_CODE])

/**
 * The codes a migration fails with while the object stays restricted, for an operator to recover: its run failed after
 * a provider accepted it, or the object refused the migration or failed to boot.
 */
export const DEPLOY_FAILED_CODE = 'deploy_failed'
export const MIGRATION_FAILED_CODE = 'migration_failed'

export type DataOperationOutcome =
	| { readonly kind: 'busy' }
	| { readonly kind: 'refused'; readonly reason: DataOperationRefusal }
	| { readonly kind: 'driven'; readonly result: DriveResult; readonly operation: DataOperationRow }

/** The pointer of an environment no restore moved: ordinary traffic reaches `application`, ops requests it and `rehearsal`. */
export const DEFAULT_APPLICATION_OBJECTS: ApplicationObjects = {
	object: DEFAULT_APPLICATION_OBJECT,
	objects: [DEFAULT_APPLICATION_OBJECT, OPS_REHEARSAL_OBJECT],
}

/**
 * The pointer Control records for the environment (ADR-0070 §9): the object every ordinary-traffic ops request names,
 * which every deploy writes as `FABRIKA_APPLICATION_OBJECT(S)`. The defaults until a restore moves it.
 */
export async function recordedObjects(
	deps: { repositories: Pick<ControlRepositories, 'applicationObjects'> },
	target: OpsTarget,
): Promise<ApplicationObjects> {
	const row = await deps.repositories.applicationObjects.get(target.appId, target.env)
	if (row === null) return DEFAULT_APPLICATION_OBJECTS
	const parsed = parseApplicationObjects(row.serving, row.listed)
	if (parsed === null) throw new Error("an environment's recorded application objects do not parse")
	return parsed
}

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

export interface StartMigrationInput {
	readonly appId: string
	readonly env: string
	/** An opaque principal id: the run's actor. */
	readonly actor: string
	/** The run whose deploy brings the migration: it is the operation's own deploy. */
	readonly runId: string
	/** Deploys that run under the operation's lease, and settles it as far as it can; the run's row then says how it ended. */
	readonly deploy: () => Promise<void>
}

/**
 * The migration phase of a deploy (ADR-0069 §3, ADR-0070 §8), under the lease the run already holds, which stays the
 * run's: `read-only` at a fresh generation, the backup at that generation and its rehearsal, the run's deploy, the
 * `migrate` request at the published generation, then `open` at a new one. A failed backup or rehearsal opens the object
 * again before anything is deployed.
 */
export async function startMigration(deps: DataOperationDeps, lease: Lease, input: StartMigrationInput): Promise<DataOperationOutcome> {
	const driver = new OperationDriver(deps, lease, input, input.deploy)
	const latest = await latestOperation(deps, input)
	if (latest?.state === 'running') return { kind: 'refused', reason: 'operation_running' }
	if ((await recordedMaintenance(deps, input)) !== 'open') return { kind: 'refused', reason: 'not_open' }
	lease.assertHeld()
	const generation = await deps.repositories.dataOperations.allocateGeneration(input.appId, input.env)
	const created = await driver.create({
		id: uuidv7(),
		appId: input.appId,
		env: input.env,
		kind: 'migrate',
		runId: input.runId,
		step: 'restrict',
		targetMode: 'read-only',
		generation,
		actor: input.actor,
	})
	await driver.backupOf(created)
	return await driver.run(created.id, false)
}

export interface StartRestoreInput {
	readonly appId: string
	readonly env: string
	/** The time the data is recovered as of, ISO 8601 in UTC with milliseconds. */
	readonly at: string
	/** An opaque principal id (`runActor`). */
	readonly actor: string
	/** The current time in milliseconds; the target time must lie before it. */
	readonly now?: number
}

/**
 * Recover the environment's data as of `at` with a side restore (ADR-0070 §9): list a clone with a deploy, freeze and
 * back up the serving object, import the backup into the clone, move ordinary traffic to it with a deploy, and only then
 * rewind the frozen original to `at`, which stays `inspect`. It starts only on an open environment whose release serves
 * the ops channel, with a free name in its object list and a succeeded deploy to redeploy.
 */
export async function startRestore(deps: DataOperationDeps, input: StartRestoreInput): Promise<DataOperationOutcome> {
	const deploys = deps.deploys
	if (deploys === undefined) return { kind: 'refused', reason: 'no_deploys' }
	if (!(Date.parse(input.at) < (input.now ?? Date.now()))) return { kind: 'refused', reason: 'not_past' }
	return await underLease(deps, input, async (driver) => {
		const latest = await latestOperation(deps, input)
		if (latest?.state === 'running') return { kind: 'refused', reason: 'operation_running' }
		if ((await recordedMaintenance(deps, input)) !== 'open') return { kind: 'refused', reason: 'not_open' }
		if ((await redeployable(deps, input)) === null) return { kind: 'refused', reason: 'nothing_deployed' }
		if (!(await deploys.servesOps(input))) return { kind: 'refused', reason: 'not_served' }
		const objects = await recordedObjects(deps, input)
		if (objects.objects.length >= MAX_APPLICATION_OBJECTS) return { kind: 'refused', reason: 'too_many_objects' }
		const probe = await driver.inspect()
		if (probe.kind !== 'ok') return { kind: 'refused', reason: probe.reason }
		const generation = await deps.repositories.dataOperations.allocateGeneration(input.appId, input.env)
		const id = uuidv7()
		const created = await driver.create({
			id,
			appId: input.appId,
			env: input.env,
			kind: 'restore',
			step: 'list',
			targetMode: 'open',
			generation,
			actor: input.actor,
		})
		await driver.restoreOf(created, { at: input.at, original: objects.object })
		await driver.backupOf(created)
		return await driver.run(created.id, false)
	})
}

/** The clone a restore imports into: a name `parseApplicationObjectName` accepts, unique to the operation. */
export function restoreClone(operationId: string): string {
	return `${DEFAULT_APPLICATION_OBJECT}-${operationId.toLowerCase()}`
}

/** What a restore's deploys redeploy: the environment's newest succeeded run, at its commit; `null` while there is none. */
async function redeployable(
	deps: { repositories: Pick<ControlRepositories, 'runs'> },
	target: OpsTarget,
): Promise<{ readonly ref: string; readonly commitSha: string } | null> {
	const run = await deps.repositories.runs.getLatestSucceededRun(target)
	return run === null || run.commit_sha === null ? null : { ref: run.ref, commitSha: run.commit_sha }
}

/** The bundle `@fabrika/app`'s object applies the application's own migrations under (`cloudflare/application.ts`). */
const APPLICATION_BUNDLE = 'app'

/** The candidate's application migrations the object has not applied, or why the object could not say. */
export type PendingMigrations =
	| { readonly kind: 'known'; readonly pending: readonly string[] }
	| { readonly kind: 'unknown'; readonly reason: OpsUnavailable }

/**
 * Which of the candidate's migration files the environment's object has not applied: the ones its build bundles (each
 * `.sql` file directly in `db/migrations`) against the object's own ledger. The ledger, not the published snapshot,
 * because a published file has not run when its version never booted or a restore rewound the database. A candidate
 * without a migration asks nothing; without a transport the answer is unknown.
 */
export async function pendingMigrations(
	ops: OpsTransport | undefined,
	target: OpsTarget,
	object: string,
	candidate: readonly { readonly name: string }[],
	signal: AbortSignal,
): Promise<PendingMigrations> {
	const bundled = candidate.map(({ name }) => name).filter((name) => name.endsWith('.sql') && !name.includes('/'))
	if (bundled.length === 0) return { kind: 'known', pending: [] }
	// An installation without a vault holds no ops key, so it reaches no object.
	if (ops === undefined) return { kind: 'unknown', reason: 'no_channel' }
	for (let attempt = 0;; attempt++) {
		const answer = await ops.inspect(target, { object, content: false }, signal)
		if (answer.kind === 'ok') {
			const applied = new Set(answer.value.view.migrations.filter((row) => row.bundle === APPLICATION_BUNDLE).map((row) => row.name))
			return { kind: 'known', pending: bundled.filter((name) => !applied.has(name)) }
		}
		if (answer.reason !== 'unreachable' || attempt + 1 >= ATTEMPTS) return { kind: 'unknown', reason: answer.reason }
	}
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

	constructor(
		private readonly deps: DataOperationDeps,
		private readonly lease: Lease,
		private readonly target: OpsTarget,
		/** The deploy of a migration's run, which only the holder running that run has; a successor reads the run's row. */
		private runDeploy?: () => Promise<void>,
	) {}

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

	/**
	 * The backup `operation` takes, recorded with a fresh dump id the first time it is asked for: of the object serving
	 * then, which for a restore is the original it recorded.
	 */
	async backupOf(operation: DataOperationRow): Promise<BackupRow> {
		const found = await this.backups.getForOperation(operation.id)
		this.lease.assertHeld()
		if (found !== null) return found
		const object = operation.kind === 'restore' ? (await this.restoreOf(operation)).original : await this.serving()
		const created = await this.backups.create(
			{
				id: uuidv7(),
				appId: operation.app_id,
				env: operation.env,
				operationId: operation.id,
				object,
				preMigration: operation.kind === 'migrate',
			},
			this.lease.fence(),
		)
		if (created !== null) return created
		this.lease.abandon()
		throw new ProviderInvocationAbort('lease_lost')
	}

	/**
	 * The restore `operation` records, created the first time it is asked for with what `start` names: the target time
	 * and the object serving when it started.
	 */
	async restoreOf(operation: DataOperationRow, start?: { readonly at: string; readonly original: string }): Promise<RestoreRow> {
		const found = await this.deps.repositories.restores.get(operation.id)
		this.lease.assertHeld()
		if (found !== null) return found
		if (start === undefined) throw new Error('a restore operation has no restore record')
		const created = await this.deps.repositories.restores.create(
			{ operationId: operation.id, appId: operation.app_id, env: operation.env, ...start, clone: restoreClone(operation.id) },
			this.lease.fence(),
		)
		if (created !== null) return created
		this.lease.abandon()
		throw new ProviderInvocationAbort('lease_lost')
	}

	/** The pointer Control records, read under the lease. */
	private async objects(): Promise<ApplicationObjects> {
		const objects = await recordedObjects(this.deps, this.target)
		this.lease.assertHeld()
		return objects
	}

	/** The object of ordinary traffic, which every request not naming another object goes to. */
	private async serving(): Promise<string> {
		return (await this.objects()).object
	}

	async inspect(object?: string): Promise<OpsAnswer<OpsInspection>> {
		const named = object ?? (await this.serving())
		this.lease.assertHeld()
		const answer = await this.deps.ops.inspect(this.target, { object: named, content: false }, this.lease.signal)
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
		if (row.kind === 'migrate') return await this.migrateStep(row)
		if (row.kind === 'restore') return await this.restoreStep(row)
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
	 * each step's progress, so a successor carries on from it, and only one backup is ever recorded. Each terminal
	 * outcome of the backup is written with the operation's step, and a step that finds it already written sends nothing.
	 */
	private async backupStep(row: DataOperationRow): Promise<Step> {
		const backup = await this.backupOf(row)
		const reopen = async (checkpoint?: BackupCheckpoint): Promise<Step> => ({
			kind: 'next',
			row: await this.advance(row, { step: 'open', targetMode: 'open', generation: await this.allocate() }, checkpoint),
		})
		switch (row.step) {
			case 'restrict': {
				const published = await this.publish(row, 'read-only')
				if (published.kind === 'refused') return await this.failed(row, published.code, failedBackup(backup, published.code))
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				return { kind: 'next', row: await this.advance(published.row, { step: 'backup' }) }
			}
			case 'backup': {
				// A failed dump still reopens the object before the operation fails.
				if (backup.state !== 'running') return await reopen()
				const dumped = await this.dump(row, backup)
				if (dumped.kind === 'paused' || dumped.kind === 'interrupted') return { kind: 'done', result: dumped.kind }
				return await reopen(dumped.kind === 'failed' ? failedBackup(backup, dumped.code) : undefined)
			}
			case 'open': {
				const published = await this.publish(row, 'open')
				if (published.kind === 'refused') return await this.failed(row, published.code, failedBackup(backup, published.code))
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				if (backup.state === 'failed') {
					// A release that does not serve the dump changed nothing the object kept: the operation before decides.
					return await this.failed(published.row, backup.error_code === NOT_SERVED_CODE ? NOT_SERVED_CODE : BACKUP_FAILED_CODE)
				}
				return { kind: 'next', row: await this.advance(published.row, { step: 'verify', generation: await this.allocate() }) }
			}
			case 'verify': {
				if (backup.state === 'failed') return await this.failed(row, backup.rehearsal === 'failed' ? REHEARSAL_FAILED_CODE : BACKUP_FAILED_CODE)
				if (backup.state === 'running') {
					const rehearsed = await this.rehearse(row, backup)
					if (rehearsed.kind === 'paused' || rehearsed.kind === 'interrupted') return { kind: 'done', result: rehearsed.kind }
					if (rehearsed.kind === 'failed') {
						return await this.failed(row, REHEARSAL_FAILED_CODE, { backupId: backup.id, outcome: 'rehearsal_failed', code: rehearsed.code })
					}
				}
				await this.finish(row, { backupId: backup.id, outcome: 'succeeded' })
				return { kind: 'done', result: 'succeeded' }
			}
			default:
				throw new Error(`a backup has no step ${row.step}`)
		}
	}

	/**
	 * A migration phase: `restrict` publishes `read-only`; `backup` takes the dump at that generation; `verify` rehearses
	 * it while the object stays restricted; `deploy` runs the operation's run, or a successor reads how it ended; `migrate`
	 * sends the request at the published generation; `open` publishes a new one. A failed dump or rehearsal, and a run
	 * that ended before a provider accepted it, go to `open` and fail the operation once the object acknowledged it. A
	 * failed deploy or migration fails the operation where it stands, the object restricted, for an operator to recover.
	 */
	private async migrateStep(row: DataOperationRow): Promise<Step> {
		const backup = await this.backupOf(row)
		const reopen = async (checkpoint?: BackupCheckpoint): Promise<Step> => ({
			kind: 'next',
			row: await this.advance(row, { step: 'open', targetMode: 'open', generation: await this.allocate() }, checkpoint),
		})
		switch (row.step) {
			case 'restrict': {
				const published = await this.publish(row, 'read-only')
				if (published.kind === 'refused') return await this.failed(row, published.code, failedBackup(backup, published.code))
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				return { kind: 'next', row: await this.advance(published.row, { step: 'backup' }) }
			}
			case 'backup': {
				if (backup.state !== 'running') return await reopen()
				const dumped = await this.dump(row, backup)
				if (dumped.kind === 'paused' || dumped.kind === 'interrupted') return { kind: 'done', result: dumped.kind }
				if (dumped.kind === 'failed') return await reopen(failedBackup(backup, dumped.code))
				return { kind: 'next', row: await this.advance(row, { step: 'verify' }) }
			}
			case 'verify': {
				if (backup.state === 'failed') return await reopen()
				if (backup.state === 'succeeded') return { kind: 'next', row: await this.advance(row, { step: 'deploy' }) }
				// The rehearsal fences `rehearsal` at the record's generation, the one the object is published at.
				const rehearsed = await this.rehearse(row, backup)
				if (rehearsed.kind === 'paused' || rehearsed.kind === 'interrupted') return { kind: 'done', result: rehearsed.kind }
				if (rehearsed.kind === 'failed') return await reopen({ backupId: backup.id, outcome: 'rehearsal_failed', code: rehearsed.code })
				return {
					kind: 'next',
					row: await this.advance(await this.require(row.id), { step: 'deploy' }, { backupId: backup.id, outcome: 'succeeded' }),
				}
			}
			case 'deploy': {
				const deploy = this.runDeploy
				this.runDeploy = undefined
				if (deploy !== undefined) await deploy()
				const run = await this.migrationRun(row)
				if (run.status === 'succeeded') return { kind: 'next', row: await this.advance(row, { step: 'migrate' }) }
				if (run.status !== 'failed') return { kind: 'done', result: 'interrupted' }
				// No provider accepted the run, so the object still runs the version it backed up.
				if (run.external_run_id === null) return await reopen()
				return await this.failed(row, DEPLOY_FAILED_CODE)
			}
			case 'migrate': {
				// A successor's fence or an adopted refusal moved the generation: the request names the published one.
				const restricted = await this.publish(row, 'read-only')
				if (restricted.kind === 'refused') return await this.failed(row, restricted.code)
				if (restricted.kind !== 'acked') return { kind: 'done', result: restricted.kind }
				const migrated = await this.migrate(restricted.row)
				if (migrated.kind === 'failed') return await this.failed(restricted.row, migrated.code)
				if (migrated.kind !== 'ok') return { kind: 'done', result: migrated.kind }
				return {
					kind: 'next',
					row: await this.advance(restricted.row, { step: 'open', targetMode: 'open', generation: await this.allocate() }),
				}
			}
			case 'open': {
				const published = await this.publish(row, 'open')
				if (published.kind === 'refused') return await this.failed(row, published.code, failedBackup(backup, published.code))
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				const reopened = await this.reopenedCode(row, backup)
				if (reopened !== null) return await this.failed(published.row, reopened)
				await this.finish(published.row)
				return { kind: 'done', result: 'succeeded' }
			}
			default:
				throw new Error(`a migration has no step ${row.step}`)
		}
	}

	/**
	 * A side restore (ADR-0070 §9). `list` deploys the clone into the object list; `restrict` publishes the original
	 * `read-only`; `backup` and `verify` take and rehearse the dump at that generation; `import` loads it into the clone,
	 * published `inspect`; `promote` publishes the clone `open` and the original `inspect` at a new generation; `point`
	 * deploys the clone as the serving object; `serve` inspects the clone; `rewind` restores the original to the target
	 * time; `check` compares its ledger with the clone's. A failure before the clone serves goes to `open` (through
	 * `revert` when traffic may already reach the clone), which opens the original again and fails with the recorded code.
	 */
	private async restoreStep(row: DataOperationRow): Promise<Step> {
		const restore = await this.restoreOf(row)
		const backup = await this.backupOf(row)
		const reopen = async (checkpoint?: BackupCheckpoint): Promise<Step> => ({
			kind: 'next',
			row: await this.advance(row, { step: 'open', targetMode: 'open', generation: await this.allocate() }, checkpoint),
		})
		/** Records why the restore stops, then opens the original again. A recorded failure is never overwritten. */
		const abandon = async (code: string, step: 'open' | 'revert' = 'open'): Promise<Step> => {
			await this.restoreFailed(restore, code)
			if (step === 'open') return await reopen()
			return { kind: 'next', row: await this.advance(row, { step: 'revert' }) }
		}
		switch (row.step) {
			case 'list': {
				const objects = await this.objects()
				// A predecessor's listing deploy succeeded and recorded the clone: nothing is deployed twice.
				// A successor's fence published `open` at the record's generation, so `read-only` goes out at a new one.
				if (objects.objects.includes(restore.clone)) {
					return { kind: 'next', row: await this.advance(row, { step: 'restrict', targetMode: 'read-only', generation: await this.allocate() }) }
				}
				if (objects.objects.length >= MAX_APPLICATION_OBJECTS) return await this.failed(row, LIST_FAILED_CODE)
				const listed = { object: objects.object, objects: [...objects.objects, restore.clone] }
				const deployed = await this.restoreDeploy(row, restore, 'list', listed)
				if (deployed === 'unsettled') return { kind: 'done', result: 'interrupted' }
				if (deployed !== 'succeeded') return await this.failed(row, LIST_FAILED_CODE)
				await this.recordObjects(listed)
				return { kind: 'next', row: await this.advance(row, { step: 'restrict', targetMode: 'read-only', generation: await this.allocate() }) }
			}
			case 'restrict': {
				const published = await this.publish(row, 'read-only', restore.original)
				if (published.kind === 'refused') return await this.failed(row, published.code, failedBackup(backup, published.code))
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				return { kind: 'next', row: await this.advance(published.row, { step: 'backup' }) }
			}
			case 'backup': {
				if (backup.state !== 'running') return await reopen()
				const dumped = await this.dump(row, backup)
				if (dumped.kind === 'paused' || dumped.kind === 'interrupted') return { kind: 'done', result: dumped.kind }
				if (dumped.kind === 'failed') return await reopen(failedBackup(backup, dumped.code))
				return { kind: 'next', row: await this.advance(row, { step: 'verify' }) }
			}
			case 'verify': {
				if (backup.state === 'failed') return await reopen()
				if (backup.state === 'succeeded') return { kind: 'next', row: await this.advance(row, { step: 'import' }) }
				const rehearsed = await this.rehearse(row, backup)
				if (rehearsed.kind === 'paused' || rehearsed.kind === 'interrupted') return { kind: 'done', result: rehearsed.kind }
				if (rehearsed.kind === 'failed') return await reopen({ backupId: backup.id, outcome: 'rehearsal_failed', code: rehearsed.code })
				return {
					kind: 'next',
					row: await this.advance(await this.require(row.id), { step: 'import' }, { backupId: backup.id, outcome: 'succeeded' }),
				}
			}
			case 'import': {
				if (restore.failure !== null) return await reopen()
				const imported = await this.importClone(row, restore, backup)
				if (imported.kind === 'paused' || imported.kind === 'interrupted') return { kind: 'done', result: imported.kind }
				// A refused import does not pass on a retry of the same backup: the original opens again and the clone, which
				// holds the import marker and so never boots, is wiped where it still can be.
				if (imported.kind === 'failed') {
					await this.importStep({ step: 'discard', object: restore.clone, generation: (await this.require(row.id)).generation })
					return await abandon(IMPORT_FAILED_CODE)
				}
				return {
					kind: 'next',
					row: await this.advance(await this.require(row.id), { step: 'promote', targetMode: 'inspect', generation: await this.allocate() }),
				}
			}
			case 'promote': {
				if (restore.failure !== null) return await reopen()
				const opened = await this.publish(row, 'open', restore.clone)
				if (opened.kind === 'refused') return await abandon(PROMOTE_FAILED_CODE)
				if (opened.kind !== 'acked') return { kind: 'done', result: opened.kind }
				// From here the original never boots again: ordinary traffic it receives is refused until the pointer moves.
				const frozen = await this.publish(opened.row, 'inspect', restore.original)
				if (frozen.kind === 'refused') return await abandon(PROMOTE_FAILED_CODE)
				if (frozen.kind !== 'acked') return { kind: 'done', result: frozen.kind }
				return { kind: 'next', row: await this.advance(frozen.row, { step: 'point' }) }
			}
			case 'point': {
				// A recorded failure goes back through `revert`, which decides whether traffic may have moved.
				if (restore.failure !== null) return { kind: 'next', row: await this.advance(row, { step: 'revert' }) }
				const objects = await this.objects()
				if (objects.object === restore.clone) return { kind: 'next', row: await this.advance(row, { step: 'serve', targetMode: 'open' }) }
				const pointed = { object: restore.clone, objects: objects.objects }
				const deployed = await this.restoreDeploy(row, restore, 'point', pointed)
				if (deployed === 'unsettled') return { kind: 'done', result: 'interrupted' }
				// A run a provider accepted may have moved traffic before it failed, so it is pointed back first.
				if (deployed === 'failed') return await abandon(POINT_FAILED_CODE, 'revert')
				if (deployed === 'not_started') return await abandon(POINT_FAILED_CODE)
				await this.recordObjects(pointed)
				return { kind: 'next', row: await this.advance(row, { step: 'serve', targetMode: 'open' }) }
			}
			case 'serve': {
				if (restore.failure !== null) return { kind: 'next', row: await this.advance(row, { step: 'revert' }) }
				await (this.deps.wait ?? abortableWait)(SERVE_GRACE_MS, this.lease.signal)
				const probe = await this.inspectWithRetry(restore.clone)
				if (probe === null) return { kind: 'done', result: 'interrupted' }
				// The original is not rewound yet, so pointing traffic back at it loses nothing.
				if (probe.bootFailure !== null) return await abandon(CLONE_NOT_SERVING_CODE, 'revert')
				return { kind: 'next', row: await this.advance(row, { step: 'rewind', generation: await this.allocate() }) }
			}
			case 'rewind':
				return await this.rewind(row, restore)
			case 'check': {
				const original = await this.inspectWithRetry(restore.original)
				const clone = original === null ? null : await this.inspectWithRetry(restore.clone)
				if (original === null || clone === null) return { kind: 'done', result: 'interrupted' }
				if (original.maintenance.mode !== 'inspect' || !ledgerWithin(original.migrations, clone.migrations)) {
					return await this.failed(row, UNEXPECTED_SCHEMA_CODE)
				}
				await this.finish(row)
				return { kind: 'done', result: 'succeeded' }
			}
			case 'revert': {
				const objects = await this.objects()
				if (objects.object !== restore.original) {
					const reverted = { object: restore.original, objects: objects.objects }
					const deployed = await this.restoreDeploy(row, restore, 'revert', reverted)
					if (deployed === 'unsettled') return { kind: 'done', result: 'interrupted' }
					if (deployed !== 'succeeded') return await this.failed(row, REVERT_FAILED_CODE)
					await this.recordObjects(reverted)
				} else if (await this.pointAccepted(restore)) {
					// The pointer deploy failed after a provider accepted it: its version may still point at the clone.
					const deployed = await this.restoreDeploy(row, restore, 'revert', objects)
					if (deployed === 'unsettled') return { kind: 'done', result: 'interrupted' }
					if (deployed !== 'succeeded') return await this.failed(row, REVERT_FAILED_CODE)
				}
				return await reopen()
			}
			case 'open': {
				if (restore.failure !== null && CLONE_OPENED_CODES.has(restore.failure)) {
					const fenced = await this.publish(row, 'inspect', restore.clone)
					if (fenced.kind === 'refused') return await this.failed(row, fenced.code)
					if (fenced.kind !== 'acked') return { kind: 'done', result: fenced.kind }
				}
				const published = await this.publish(row, 'open', restore.original)
				if (published.kind === 'refused') return await this.failed(row, published.code, failedBackup(backup, published.code))
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				return await this.failed(published.row, reopenedRestoreCode(backup, restore))
			}
			default:
				throw new Error(`a restore has no step ${row.step}`)
		}
	}

	/**
	 * One of a restore's deploys, from the record: the run it names, created the first time to redeploy what the
	 * environment runs now, then run under this lease with `objects` as the pointer. `not_started`: no provider accepted
	 * it, or there was nothing to redeploy; `unsettled`: no outcome yet, or no deploys to run it with.
	 */
	private async restoreDeploy(
		row: DataOperationRow,
		restore: RestoreRow,
		deploy: RestoreDeploy,
		objects: ApplicationObjects,
	): Promise<'succeeded' | 'failed' | 'not_started' | 'unsettled'> {
		const deploys = this.deps.deploys
		if (deploys === undefined) return 'unsettled'
		let runId = restoreRun(restore, deploy)
		if (runId === null) {
			runId = uuidv7()
			this.lease.assertWritten(await this.deps.repositories.restores.nameRun(restore.operation_id, deploy, runId, this.lease.fence()))
		}
		let run = await this.deps.repositories.runs.getRun(runId)
		this.lease.assertHeld()
		if (run === null) {
			const source = await redeployable(this.deps, this.target)
			this.lease.assertHeld()
			if (source === null) return 'not_started'
			run = await this.deps.repositories.runs.createRun({ id: runId, appId: row.app_id, env: row.env, ...source, trigger: 'manual', actor: row.actor })
		}
		if (run.status === 'pending' || run.status === 'running') {
			await deploys.run(this.lease, runId, objects)
			this.lease.assertHeld()
			run = await this.deps.repositories.runs.getRun(runId)
			this.lease.assertHeld()
			if (run === null) throw new Error("a restore's run vanished")
		}
		if (run.status === 'succeeded') return 'succeeded'
		// A parked run waits for a human and no provider has it; a failed one no provider accepted changed nothing.
		if (run.status === 'awaiting_approval' || (run.status === 'failed' && run.external_run_id === null)) return 'not_started'
		return run.status === 'failed' ? 'failed' : 'unsettled'
	}

	/**
	 * Load the backup into the clone (ADR-0070 §6), fenced `inspect` at the record's generation. Every step is replayed
	 * from `begin`, which the importer resumes from its marker, and a loaded part or a set link answers its receipt again.
	 * A `begin` refused as `not_fresh` after a `complete` whose answer was lost is answered by the completion receipt.
	 */
	private async importClone(row: DataOperationRow, restore: RestoreRow, backup: BackupRow): Promise<DataResult<null>> {
		const fenced = await this.publish(row, 'inspect', restore.clone)
		if (fenced.kind === 'refused') return { kind: 'failed', code: fenced.code }
		if (fenced.kind !== 'acked') return fenced
		const source = { object: backup.object, dump: backup.dump_id }
		const scope = { object: restore.clone, generation: fenced.row.generation, source }
		const complete = async (): Promise<DataResult<null>> => {
			const completed = await this.importStep({ ...scope, step: 'complete' })
			if (completed.kind !== 'ok') return completed
			if (completed.value.step !== 'complete' || completed.value.source.dump !== source.dump) return invalidAnswer()
			return { kind: 'ok', value: null }
		}
		const begun = await this.importStep({ ...scope, step: 'begin' })
		if (begun.kind === 'failed' && begun.code === 'not_fresh') return await complete()
		if (begun.kind !== 'ok') return begun
		if (begun.value.step !== 'begin' || begun.value.parts !== backup.parts) return invalidAnswer()
		const deferred: number[] = []
		for (let part = 1; part <= begun.value.parts; part++) {
			const loaded = await this.importStep({ ...scope, step: 'part', part })
			if (loaded.kind !== 'ok') return loaded
			if (loaded.value.step !== 'part' || loaded.value.part !== part) return invalidAnswer()
			if (loaded.value.deferred > 0) deferred.push(part)
		}
		for (const part of deferred) {
			const linked = await this.importStep({ ...scope, step: 'link', part })
			if (linked.kind !== 'ok') return linked
			if (linked.value.step !== 'link' || linked.value.part !== part) return invalidAnswer()
		}
		let cursor: OpsImportVerifyAck['next'] = null
		do {
			const verified = await this.importStep({ ...scope, step: 'verify', cursor })
			if (verified.kind !== 'ok') return verified
			if (verified.value.step !== 'verify') return invalidAnswer()
			cursor = verified.value.next
		} while (cursor !== null)
		return await complete()
	}

	/**
	 * Rewind the original (ADR-0070 §9 step 6), from the record: fence it `inspect` at the record's generation; `prepare`
	 * once, recording both bookmarks before any `arm`; then each `arm` counted before it is sent, and a `verify` after it,
	 * since its answer may be lost to the reset. A recorded `arm` is verified before another is sent. An absent sentinel is
	 * the restore; a present one arms again, at most `MAX_ARMS` times.
	 */
	private async rewind(start: DataOperationRow, initial: RestoreRow): Promise<Step> {
		const fenced = await this.publish(start, 'inspect', initial.original)
		if (fenced.kind === 'refused') return await this.failed(start, REWIND_FAILED_CODE)
		if (fenced.kind !== 'acked') return { kind: 'done', result: fenced.kind }
		const row = fenced.row
		const object = initial.original
		const sentinel = row.id
		let restore = initial
		if (restore.target_bookmark === null) {
			const prepared = await this.restoreRequest({ step: 'prepare', object, generation: row.generation, sentinel, at: restore.at })
			if (prepared.kind === 'failed') {
				return await this.failed(row, prepared.code === 'bookmark_unavailable' ? BOOKMARK_UNAVAILABLE_CODE : REWIND_FAILED_CODE)
			}
			if (prepared.kind !== 'ok') return { kind: 'done', result: prepared.kind }
			if (prepared.value.step !== 'prepare') return await this.failed(row, 'invalid_answer')
			const bookmarks = { current: prepared.value.current, target: prepared.value.target }
			this.lease.assertWritten(await this.deps.repositories.restores.prepared(restore.operation_id, bookmarks, this.lease.fence()))
			restore = await this.restoreOf(row)
		}
		const target = restore.target_bookmark
		if (target === null) throw new Error('a prepared restore lost its target bookmark')
		for (;;) {
			if (restore.arms > 0) {
				const verified = await this.restoreRequest({ step: 'verify', object, sentinel })
				if (verified.kind === 'failed') return await this.failed(row, REWIND_FAILED_CODE)
				if (verified.kind !== 'ok') return { kind: 'done', result: verified.kind }
				if (verified.value.step !== 'verify') return await this.failed(row, 'invalid_answer')
				if (verified.value.sentinel === 'absent') return { kind: 'next', row: await this.advance(row, { step: 'check' }) }
				if (restore.arms >= MAX_ARMS) return await this.failed(row, REWIND_FAILED_CODE)
			}
			this.lease.assertWritten(await this.deps.repositories.restores.arming(restore.operation_id, restore.arms, this.lease.fence()))
			const armed = await this.restoreRequest({ step: 'arm', object, generation: row.generation, sentinel, target })
			if (armed.kind === 'failed') return await this.failed(row, armed.code === 'bookmark_unavailable' ? BOOKMARK_UNAVAILABLE_CODE : REWIND_FAILED_CODE)
			if (armed.kind === 'paused') return { kind: 'done', result: 'paused' }
			// A lost answer is the expected one: the object resets right after it answers, and `verify` decides.
			if (armed.kind === 'ok' && armed.value.step === 'arm') {
				this.lease.assertWritten(await this.deps.repositories.restores.armed(restore.operation_id, armed.value.undo, this.lease.fence()))
			}
			await (this.deps.wait ?? abortableWait)(RESET_GRACE_MS, this.lease.signal)
			restore = await this.restoreOf(row)
		}
	}

	/** Whether a provider accepted the restore's pointer deploy, so the version running may point at the clone. */
	private async pointAccepted(restore: RestoreRow): Promise<boolean> {
		if (restore.point_run_id === null) return false
		const run = await this.deps.repositories.runs.getRun(restore.point_run_id)
		this.lease.assertHeld()
		return run !== null && run.external_run_id !== null
	}

	/** The object's view, repeating a lost answer; `null` when no answer came. */
	private async inspectWithRetry(object: string): Promise<OpsView | null> {
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			const answer = await this.inspect(object)
			if (answer.kind === 'ok') return answer.value.view
			if (answer.reason !== 'unreachable') return null
		}
		return null
	}

	private async recordObjects(objects: ApplicationObjects): Promise<void> {
		const recorded = await this.deps.repositories.applicationObjects.set(
			this.target.appId,
			this.target.env,
			{ serving: objects.object, listed: objects.objects },
			this.lease.fence(),
		)
		this.lease.assertWritten(recorded)
	}

	private async restoreFailed(restore: RestoreRow, code: string): Promise<void> {
		if (restore.failure !== null) return
		this.lease.assertWritten(await this.deps.repositories.restores.failed(restore.operation_id, code, this.lease.fence()))
	}

	/** Why a migration reached `open` without migrating, or `null` once its backup passed and its run succeeded. */
	private async reopenedCode(row: DataOperationRow, backup: BackupRow): Promise<string | null> {
		if (backup.rehearsal === 'failed') return REHEARSAL_FAILED_CODE
		if (backup.state === 'failed') return backup.error_code === NOT_SERVED_CODE ? NOT_SERVED_CODE : BACKUP_FAILED_CODE
		return (await this.migrationRun(row)).status === 'succeeded' ? null : DEPLOY_NOT_STARTED_CODE
	}

	private async migrationRun(row: DataOperationRow): Promise<RunRow> {
		if (row.run_id === null) throw new Error('a migration names no run')
		const run = await this.deps.repositories.runs.getRun(row.run_id)
		this.lease.assertHeld()
		if (run === null) throw new Error("a migration's run vanished")
		return run
	}

	/**
	 * The `migrate` request at the record's generation. A lost answer repeats it. The object answers a failed boot with a
	 * 500, which reads as unreachable, so once the attempts are spent its view says whether the boot failed.
	 */
	private async migrate(row: DataOperationRow): Promise<DataResult<null>> {
		const object = await this.serving()
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			this.lease.assertHeld()
			const answer = await this.deps.ops.migrate(this.target, { object, generation: row.generation }, this.lease.signal)
			this.lease.assertHeld()
			if (answer.kind === 'ok') return answer.value.generation === row.generation ? { kind: 'ok', value: null } : { kind: 'interrupted' }
			if (answer.kind === 'stale') return { kind: 'failed', code: 'stale_generation' }
			if (answer.reason === 'not_served') return { kind: 'failed', code: MIGRATION_FAILED_CODE }
			if (answer.reason !== 'unreachable') return { kind: 'interrupted' }
		}
		const probe = await this.inspect()
		return probe.kind === 'ok' && probe.value.view.bootFailure !== null ? { kind: 'failed', code: MIGRATION_FAILED_CODE } : { kind: 'interrupted' }
	}

	/**
	 * The consistent dump (ADR-0070 §2), from the progress the record holds: `begin` once, each part from the cursor the
	 * last recorded part answered, then `complete` with the recorded parts and tables, whose manifest must describe them.
	 * A resumed dump sends `begin` again, which the exporter replays while the dump's state and stretch hold (§2). Its
	 * `ledger_mismatch` means the recorded upload can never complete: the dump starts again under a new dump id, and the
	 * old upload is left to the bucket's lifecycle.
	 */
	private async dump(row: DataOperationRow, start: BackupRow): Promise<DataResult<null>> {
		let backup = start
		if (backup.parts !== null) return { kind: 'ok', value: null }
		let scope = { object: backup.object, generation: row.generation, consistent: true, dump: backup.dump_id }
		let begun = await this.exportStep({ ...scope, step: 'begin' })
		if (begun.kind === 'failed' && begun.code === 'ledger_mismatch') {
			this.lease.assertWritten(await this.backups.restart(backup.id, uuidv7(), this.lease.fence()))
			backup = await this.requireBackup(backup.id)
			scope = { ...scope, dump: backup.dump_id }
			begun = await this.exportStep({ ...scope, step: 'begin' })
		}
		if (begun.kind !== 'ok') return begun
		if (begun.value.step !== 'begin') return invalidAnswer()
		if (backup.upload_id === null || backup.bookmark === null) {
			this.lease.assertWritten(await this.backups.begun(backup.id, begun.value, this.lease.fence()))
			backup = await this.requireBackup(backup.id)
		} else if (begun.value.uploadId !== backup.upload_id || begun.value.bookmark !== backup.bookmark) {
			return invalidAnswer()
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
		const source = { object: initial.object, dump: initial.dump_id }
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

	/** A restore step; an `arm` goes out once, since its answer is lost to the reset it starts and only `verify` tells. */
	private async restoreRequest(request: OpsRestoreRequest): Promise<DataResult<OpsRestoreAck>> {
		return await this.dataStep((signal) => this.deps.ops.restore(this.target, request, signal), request.step === 'arm' ? 1 : ATTEMPTS)
	}

	/**
	 * One dump or import request, sent only while the pass has time and the lease holds. A lost answer repeats it, which
	 * every step tolerates. A refusal, a stale generation and any other unusable answer fail it with a code.
	 */
	private async dataStep<T>(send: (signal: AbortSignal) => Promise<OpsDataAnswer<T>>, attempts = ATTEMPTS): Promise<DataResult<T>> {
		for (let attempt = 0; attempt < attempts; attempt++) {
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
	private async publish(start: DataOperationRow, mode: OpsMode, named?: string): Promise<Published> {
		const object = named ?? (await this.serving())
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

	private async advance(
		row: DataOperationRow,
		change: Omit<DataOperationAdvance, 'expectedStep'>,
		checkpoint?: BackupCheckpoint,
	): Promise<DataOperationRow> {
		// Under this holder's lease nobody else moves the step, so a refused write means the lease is gone.
		this.lease.assertWritten(await this.records.advance(row.id, { expectedStep: row.step, ...change }, this.lease.fence(), checkpoint))
		return await this.require(row.id)
	}

	private async finish(row: DataOperationRow, checkpoint?: BackupCheckpoint): Promise<void> {
		this.lease.assertWritten(await this.records.finish(row.id, this.lease.fence(), checkpoint))
	}

	private async fail(row: DataOperationRow, code: string, checkpoint?: BackupCheckpoint): Promise<void> {
		this.lease.assertWritten(await this.records.fail(row.id, code, this.lease.fence(), checkpoint))
	}

	private async failed(
		row: DataOperationRow,
		code: string,
		checkpoint?: BackupCheckpoint,
	): Promise<{ readonly kind: 'done'; readonly result: 'failed' }> {
		await this.fail(row, code, checkpoint)
		return { kind: 'done', result: 'failed' }
	}
}

/** How long a restore waits after the pointer deploy before it inspects the clone, so traffic can reach it and boot it. */
const SERVE_GRACE_MS = 30_000
/** How long a restore waits after an `arm` before its `verify`: the object resets only once it answered. */
const RESET_GRACE_MS = 2_000
/** How many `arm`s a rewind sends before it fails: one that never resets the object is not tried for ever. */
const MAX_ARMS = 3

/** The run a restore's deploy names, `null` before it was named. */
function restoreRun(restore: RestoreRow, deploy: RestoreDeploy): string | null {
	switch (deploy) {
		case 'list':
			return restore.list_run_id
		case 'point':
			return restore.point_run_id
		case 'revert':
			return restore.revert_run_id
	}
}

/** Why a restore that reached `open` stops: its backup or rehearsal failed, or the code it recorded. */
function reopenedRestoreCode(backup: BackupRow, restore: RestoreRow): string {
	if (backup.rehearsal === 'failed') return REHEARSAL_FAILED_CODE
	if (backup.state === 'failed') return backup.error_code === NOT_SERVED_CODE ? NOT_SERVED_CODE : BACKUP_FAILED_CODE
	if (restore.failure === null) throw new Error('a restore reached open with nothing recorded against it')
	return restore.failure
}

/**
 * Whether the rewound original's migration ledger is one the clone's could have grown from: every migration the original
 * applied, the clone applied too, under the same checksum. The clone holds the original's data as it was frozen, and
 * the original at an earlier time can only miss migrations, never hold another.
 */
function ledgerWithin(original: readonly OpsMigration[], clone: readonly OpsMigration[]): boolean {
	const key = (row: OpsMigration): string => JSON.stringify([row.bundle, row.name, row.checksum])
	const applied = new Set(clone.map(key))
	return original.every((row) => applied.has(key(row)))
}

/** The checkpoint that fails a backup still running with `code`; none once it ended. */
function failedBackup(backup: BackupRow, code: string): BackupCheckpoint | undefined {
	return backup.state === 'running' ? { backupId: backup.id, outcome: 'failed', code } : undefined
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
	return manifest.dump === backup.dump_id && manifest.object === backup.object && manifest.consistent && manifest.bookmark === bookmark && sameParts
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
		operation: 'export' | 'import' | 'restore',
		body: OpsExportRequest | OpsImportRequest | OpsRestoreRequest,
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
		restore: (target, request, signal) => data(target, 'restore', request, signal, (body) => parseRestoreAck(request, body)),
	}
}

type OpsRequest = OpsInspectRequest | OpsStateRequest | OpsMigrateRequest | OpsExportRequest | OpsImportRequest | OpsRestoreRequest

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

/** The answer to a restore step, by the parser of the step it answers. */
function parseRestoreAck(request: OpsRestoreRequest, body: unknown): OpsRestoreAck | null {
	switch (request.step) {
		case 'prepare':
			return parseOpsRestorePrepareAck(body)
		case 'arm':
			return parseOpsRestoreArmAck(body)
		case 'verify':
			return parseOpsRestoreVerifyAck(body)
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
