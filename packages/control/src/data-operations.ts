// Control drives a data operation on an application environment's object (ADR-0069 §3): it allocates every
// generation, records each step under the environment's deploy lease, and reaches the object only through the injected
// `OpsTransport`. Control's record is the authority; the object's published state is a copy it reconciles with.

import {
	DEFAULT_APPLICATION_OBJECT,
	OPS_CONTENT_TYPE,
	OPS_METHOD,
	OPS_REFUSAL_STATUS,
	OPS_STALE_STATUS,
	type OpsContentView,
	type OpsInspectRequest,
	type OpsMigrateAck,
	type OpsMigrateRequest,
	type OpsMode,
	type OpsOperation,
	opsPath,
	type OpsPublishedState,
	type OpsStateAck,
	type OpsStateRequest,
	type OpsView,
	parseOpsContentView,
	parseOpsMigrateAck,
	parseOpsStaleRefusal,
	parseOpsStateAck,
	parseOpsView,
} from '@fabrika/auth-core'
import type { DataOperationDto } from '@fabrika/control-contract'
import { type DeployLocks, uuidv7 } from '@fabrika/platform'
import { isLeaseLoss, ProviderInvocationAbort } from '@fabrika/provider-contract'
import type {
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
 * refusal came back, the object could not be reached, answered 5xx or refused every key Control holds, or its answer did
 * not parse. Only `unreachable` is worth repeating at once.
 */
export type OpsUnavailable = 'no_channel' | 'channel_refused' | 'unreachable' | 'invalid_answer'

/** The view `inspect` returned, in the form its request asked for. */
export type OpsInspection = { readonly content: false; readonly view: OpsView } | { readonly content: true; readonly view: OpsContentView }

export type OpsAnswer<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'unavailable'; readonly reason: OpsUnavailable }

/** A mutating request's answer: also the 409 stale refusal, naming what the object has published. */
export type OpsFencedAnswer<T> = OpsAnswer<T> | { readonly kind: 'stale'; readonly published: OpsPublishedState | null }

/** Control's calls to an environment's object; every answer is parsed before it is returned. */
export interface OpsTransport {
	inspect(target: OpsTarget, request: OpsInspectRequest, signal: AbortSignal): Promise<OpsAnswer<OpsInspection>>
	state(target: OpsTarget, request: OpsStateRequest, signal: AbortSignal): Promise<OpsFencedAnswer<OpsStateAck>>
	migrate(target: OpsTarget, request: OpsMigrateRequest, signal: AbortSignal): Promise<OpsFencedAnswer<OpsMigrateAck>>
}

export interface DataOperationDeps {
	repositories: Pick<ControlRepositories, 'dataOperations'>
	lock: DeployLocks
	leaseClock?: LeaseClock
	ops: OpsTransport
}

/**
 * Why an operation was not started or advanced: one is still running, the recovery target cannot be recovered, the
 * operation is no longer the environment's newest running one, or the channel.
 */
export type DataOperationRefusal = 'operation_running' | 'not_recoverable' | 'superseded' | OpsUnavailable

/**
 * `interrupted`: the object gave no answer to act on, so the record keeps running at its step and the environment stays
 * in its last acknowledged mode. `lease_lost`: the operation stopped without effect at its next check.
 */
export type DriveResult = 'succeeded' | 'failed' | 'interrupted' | 'lease_lost'

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
 * succeeded, and `unsettled` while it runs or after it failed, when the object may hold any mode it was sent.
 */
export async function recordedMaintenance(deps: Pick<DataOperationDeps, 'repositories'>, target: OpsTarget): Promise<OpsMode | 'unsettled'> {
	const latest = await latestOperation(deps, target)
	if (latest === null) return 'open'
	return latest.state === 'succeeded' ? latest.target_mode : 'unsettled'
}

export async function listDataOperations(
	deps: Pick<DataOperationDeps, 'repositories'>,
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

async function latestOperation(deps: Pick<DataOperationDeps, 'repositories'>, target: OpsTarget): Promise<DataOperationRow | null> {
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

type Published = { readonly kind: 'acked'; readonly row: DataOperationRow } | { readonly kind: 'failed' | 'interrupted' }

type Step = { readonly kind: 'next'; readonly row: DataOperationRow } | { readonly kind: 'done'; readonly result: Exclude<DriveResult, 'lease_lost'> }

/** One holder's run of an operation. Every write is fenced on its lease, and each request goes out only while it holds it. */
class OperationDriver {
	/** What this holder saw the object acknowledge, so a step after a successor's fence does not publish it twice. */
	private acknowledged: OpsPublishedState | null = null

	constructor(private readonly deps: DataOperationDeps, private readonly lease: Lease, private readonly target: OpsTarget) {}

	private get records() {
		return this.deps.repositories.dataOperations
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
			if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
			await this.finish(published.row)
			return { kind: 'done', result: 'succeeded' }
		}
		if (row.kind === 'recovery') return await this.recoveryStep(row)
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
				if (fenced.kind !== 'acked') return { kind: 'done', result: fenced.kind }
				if (row.resolution === 'open') {
					return { kind: 'next', row: await this.advance(fenced.row, { step: 'open', targetMode: 'open', generation: await this.allocate() }) }
				}
				const interrupted = await this.require(interruptedId)
				return { kind: 'next', row: await this.advance(fenced.row, { step: 'resume', targetMode: interrupted.target_mode }) }
			}
			case 'open': {
				const published = await this.publish(row, 'open')
				if (published.kind !== 'acked') return { kind: 'done', result: published.kind }
				await this.retireChain(row, 'recovered_open')
				await this.finish(published.row)
				return { kind: 'done', result: 'succeeded' }
			}
			case 'resume': {
				const resumed = await this.drive(interruptedId, true)
				if (resumed === 'interrupted') return { kind: 'done', result: 'interrupted' }
				if (resumed === 'failed') {
					await this.fail(row, 'resume_failed')
					return { kind: 'done', result: 'failed' }
				}
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
	 * Publish `mode` at the record's generation. A lost answer repeats the same generation and mode, which the object
	 * treats as a retry. A stale refusal naming a higher generation is adopted once: the fenced write of a fresh
	 * generation proves the lease is still this holder's, or aborts it, and the transition is sent again.
	 */
	private async publish(start: DataOperationRow, mode: OpsMode): Promise<Published> {
		let row = start
		let adopted = false
		let attempts = 0
		while (attempts < ATTEMPTS) {
			if (this.acknowledged?.generation === row.generation && this.acknowledged.mode === mode) return { kind: 'acked', row }
			this.lease.assertHeld()
			const answer = await this.deps.ops.state(this.target, { object: OBJECT, generation: row.generation, mode }, this.lease.signal)
			this.lease.assertHeld()
			if (answer.kind === 'ok') {
				if (answer.value.generation !== row.generation || answer.value.mode !== mode) return { kind: 'interrupted' }
				this.acknowledged = { generation: row.generation, mode }
				return { kind: 'acked', row }
			}
			if (answer.kind === 'stale') {
				if (adopted || answer.published === null || answer.published.generation <= row.generation) {
					await this.fail(row, 'stale_generation')
					return { kind: 'failed' }
				}
				adopted = true
				row = await this.advance(row, { step: row.step, generation: await this.allocate() })
				continue
			}
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
		body: OpsInspectRequest | OpsStateRequest | OpsMigrateRequest,
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
		body: OpsInspectRequest | OpsStateRequest | OpsMigrateRequest,
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
			if (response.status >= 500) return 'unreachable'
			if (response.status !== 200 && response.status !== OPS_STALE_STATUS) return 'invalid_answer'
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
		if (answer.status === OPS_STALE_STATUS) {
			const refusal = parseOpsStaleRefusal(answer.body)
			return refusal === null ? { kind: 'unavailable', reason: 'invalid_answer' } : { kind: 'stale', published: refusal.published }
		}
		const value = parse(answer.body)
		return value === null ? { kind: 'unavailable', reason: 'invalid_answer' } : { kind: 'ok', value }
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
