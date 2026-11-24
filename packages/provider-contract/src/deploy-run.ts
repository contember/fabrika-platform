// The deploy run every cloud shares (ADR-0044): a provider's steps in order, the checkpoint each submitting call is
// recorded behind, the wait for the submitted candidate, and the recovery that settles a run without resuming it.
// A provider supplies its steps and a `RunAttempt`: its checkpoint and the few calls on its candidate.

import type { ProviderCancelInput, ProviderCancelOutcome, ProviderReconcileInput, ProviderReconcileOutcome, ProviderRunEvents } from './control'
import { isLeaseLoss, ProviderInvocationAbort } from './control'
import type { JsonValue } from './json'
import { type DeployStepResult, runSteps, type RunStepsOptions } from './steps'

/** One read of the candidate. */
export type RunObservation =
	| { readonly state: 'active' }
	| { readonly state: 'failed'; readonly reason: string }
	/** Not terminal yet; `status` is the platform's word for it, for the run log. */
	| { readonly state: 'pending'; readonly status?: string }
	/** The candidate no longer exists. */
	| { readonly state: 'absent' }
	/** The read failed; `cause` is what it threw. */
	| { readonly state: 'unobservable'; readonly cause: unknown }

/**
 * A provider's candidate and its checkpoint `C`: the credential-free record Control stores with the run. The checkpoint
 * is written before each call that needs it, and one that says the activating call may have been sent is settled only
 * by polling, never by `discard`.
 */
export interface RunAttempt<C> {
	/** The checkpoint, or null for any other shape (an older one included). */
	parse(state: JsonValue | undefined): C | null
	/** The checkpoint as Control stores it; `parse` reads it back. */
	encode(checkpoint: C): JsonValue
	/** The run's external id: recorded with the first checkpoint; `record` refuses a later one naming another. */
	externalId(checkpoint: C): string
	/** Whether the call that may activate the candidate may have been sent. */
	submitted(checkpoint: C): boolean
	/** Remove what an unsubmitted candidate left, so nothing of it can activate. An already absent one is no error. */
	discard(checkpoint: C, signal: AbortSignal): Promise<void>
	/** One read of the candidate, for a cancel and a recovery. */
	observe(checkpoint: C, signal: AbortSignal): Promise<RunObservation>
	/** Ask the platform to stop the candidate's work. Best effort: its failure never decides an outcome. */
	stop(checkpoint: C, signal: AbortSignal): Promise<void>
	/** How long after the run started an unsettled candidate is abandoned. */
	readonly deadlineMs: number
	/** The provider's words in the run log. */
	readonly words: RunAttemptWords<C>
}

export interface RunAttemptWords<C> {
	/** Prefixes a failure the run reports, e.g. `zerops`. */
	readonly provider: string
	/** The candidate, e.g. `app-version <id>`. */
	candidate(checkpoint: C): string
	/** What `discard` did, in the past tense, e.g. `deleted`. */
	readonly discarded: string
	/** Why a failed discard leaves nothing that can activate, e.g. `could not be deleted; it was never built`. */
	readonly notDiscarded: string
	/** The activating call, after `stopped before it`, e.g. `requested the build`. */
	readonly submission: string
}

/** How long a best-effort stop may take. */
const STOP_TIMEOUT_MS = 5000

/** Best effort: the caller is already giving up or settling, so a failed stop must not replace the reason. */
const stopQuietly = async <C>(attempt: RunAttempt<C>, checkpoint: C, signal?: AbortSignal): Promise<void> => {
	signal?.throwIfAborted()
	const bounded = signal === undefined ? AbortSignal.timeout(STOP_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(STOP_TIMEOUT_MS)])
	await attempt.stop(checkpoint, bounded).catch(() => {})
}

/** What a step of a deploy run is handed. */
export interface DeployRunContext<C> {
	/** The checkpoint this invocation last recorded, or the unsubmitted one whose recording failed. */
	readonly checkpoint: C | undefined
	/**
	 * Record `checkpoint` before the call that needs it. The first one also records the run's external id. An
	 * unsubmitted checkpoint counts at once, because the candidate it names may already exist (`discard` takes an absent
	 * one as no error); a submitted one counts only once it is stored, because the call it allows is sent only after.
	 */
	record(checkpoint: C): Promise<void>
}

export interface DeployRunInput<C, TStep> {
	readonly attempt: RunAttempt<C>
	readonly steps: readonly TStep[]
	readonly options: RunStepsOptions
	readonly events: ProviderRunEvents
	readonly runOne: (step: TStep, context: DeployRunContext<C>) => Promise<void>
}

export interface DeployRunResult<C> {
	readonly status: 'succeeded' | 'failed'
	readonly steps: readonly DeployStepResult[]
	readonly checkpoint: C | undefined
}

/**
 * Run a provider's steps in order behind the checkpoint. A failed run whose candidate was never submitted discards it;
 * a cancelled run leaves it to `cancelRun`, and a lost lease to the next owner.
 */
export const runDeploy = async <C, TStep extends { readonly id: string; readonly description: string }>(
	input: DeployRunInput<C, TStep>,
): Promise<DeployRunResult<C>> => {
	const { attempt, events, options } = input
	let checkpoint: C | undefined
	let recordedExternalId: string | undefined
	const context: DeployRunContext<C> = {
		get checkpoint() {
			return checkpoint
		},
		record: async (next) => {
			const externalId = attempt.externalId(next)
			// Recovery matches the stored checkpoint to the run's one external id, so a run never changes it.
			if (recordedExternalId !== undefined && externalId !== recordedExternalId) {
				throw new Error(`${attempt.words.provider}: a checkpoint names another external id than the run recorded`)
			}
			if (!attempt.submitted(next)) checkpoint = next
			if (recordedExternalId === undefined) await events.externalId(externalId, attempt.encode(next))
			else await events.checkpoint(attempt.encode(next))
			recordedExternalId = externalId
			checkpoint = next
		},
	}
	const result = await runSteps(input.steps, options, (step) => input.runOne(step, context))
	const settled = checkpoint
	if (result.status === 'failed' && settled !== undefined && !attempt.submitted(settled) && !options.signal.aborted) {
		const { words } = attempt
		try {
			await attempt.discard(settled, options.signal)
			options.log(`  ${words.discarded} ${words.candidate(settled)}`)
		} catch {
			options.log(`  [warn] ${words.candidate(settled)} ${words.notDiscarded}`)
		}
	}
	return { ...result, checkpoint: settled }
}

export interface AwaitSettlementInput<C> {
	readonly attempt: RunAttempt<C>
	readonly checkpoint: C
	readonly events: ProviderRunEvents
	readonly signal: AbortSignal
	/** The instant the wait gives up, stopping the candidate's work. */
	readonly giveUpAtMs: number
	readonly intervalMs: number
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	/** One read in the live run; it may relay the build's log. A throw fails the wait. */
	readonly observe: (signal: AbortSignal) => Promise<RunObservation>
}

/**
 * Poll the candidate's work until `observe` answers active; any other end throws. It serves a submitted candidate's
 * rollout and any wait before submission (a build the activating call needs) alike: a cancel read at a boundary
 * stops the work and throws `cancel_requested`, the deadline stops it and fails, and a lost lease throws without
 * stopping anything (ADR-0044). What a failed run does with an unsubmitted candidate is `runDeploy`'s.
 */
export const awaitSettlement = async <C>(input: AwaitSettlementInput<C>): Promise<void> => {
	const { attempt, checkpoint, signal } = input
	const timedOut = async (): Promise<never> => {
		await stopQuietly(attempt, checkpoint)
		throw new Error(`${attempt.words.provider}: gave up waiting for ${attempt.words.candidate(checkpoint)} at the run deadline`)
	}
	for (;;) {
		// Only a boundary that still holds the lease may stop the candidate; a lost lease rejects it as lease_lost.
		const crossed: unknown = await input.events.boundary().then(() => null, (error: unknown) => error)
		if (isLeaseLoss(crossed)) throw crossed
		if (signal.aborted) {
			if (isLeaseLoss(signal.reason)) throw signal.reason
			await stopQuietly(attempt, checkpoint)
			throw new ProviderInvocationAbort('cancel_requested')
		}
		const observed = await input.observe(signal)
		if (observed.state === 'unobservable') {
			if (Date.now() > input.giveUpAtMs) await timedOut()
			await input.sleep(input.intervalMs, signal)
			continue
		}
		// A cancel that arrived during the read is handled at the next boundary.
		if (signal.aborted) continue
		if (observed.state === 'active') return
		if (observed.state === 'failed') throw new Error(observed.reason)
		if (observed.state === 'absent') throw new Error(`${attempt.words.provider}: ${attempt.words.candidate(checkpoint)} no longer exists`)
		if (Date.now() > input.giveUpAtMs) await timedOut()
		await input.sleep(input.intervalMs, signal)
	}
}

/** The recorded checkpoint of exactly this run's external id, or null. */
const recordedCheckpoint = <C>(attempt: RunAttempt<C>, input: { readonly providerState?: JsonValue; readonly externalId: string }): C | null => {
	const checkpoint = attempt.parse(input.providerState)
	return checkpoint !== null && attempt.externalId(checkpoint) === input.externalId ? checkpoint : null
}

const pastDeadline = (attempt: RunAttempt<unknown>, startedAtMs: number | undefined): boolean =>
	startedAtMs !== undefined && Date.now() > startedAtMs + attempt.deadlineMs

/**
 * Cancel a run by its checkpoint. An unsubmitted candidate is discarded; a submitted one is asked to stop and stays
 * pending until it settles. Cancellation never implies rollback: a candidate that activated first succeeds.
 */
export const cancelRun = async <C>(attempt: RunAttempt<C>, input: ProviderCancelInput): Promise<ProviderCancelOutcome> => {
	const signal = input.signal
	signal.throwIfAborted()
	const checkpoint = recordedCheckpoint(attempt, input)
	if (checkpoint === null) return { state: 'settled', outcome: 'failed' }
	if (!attempt.submitted(checkpoint)) {
		try {
			await attempt.discard(checkpoint, signal)
		} catch {
			signal.throwIfAborted()
			return { state: 'pending' }
		}
		return { state: 'settled', outcome: 'failed' }
	}
	const observed = await attempt.observe(checkpoint, signal)
	if (observed.state === 'unobservable') throw observed.cause
	if (observed.state === 'active') return { state: 'settled', outcome: 'succeeded' }
	if (observed.state !== 'pending') return { state: 'settled', outcome: 'failed' }
	await stopQuietly(attempt, checkpoint, signal)
	// A submission that never landed may leave the candidate pending for good; the deadline settles it.
	return pastDeadline(attempt, input.startedAtMs) ? { state: 'settled', outcome: 'failed' } : { state: 'pending' }
}

/**
 * Settle a run its owner left unfinished, without resuming it (ADR-0044). An unsubmitted candidate is discarded and
 * the run fails; a submitted one is polled, and abandoned past the deadline. A throw keeps the run running.
 */
export const reconcileRun = async <C>(attempt: RunAttempt<C>, input: ProviderReconcileInput): Promise<ProviderReconcileOutcome> => {
	const signal = input.signal
	signal.throwIfAborted()
	const { words } = attempt
	const log = async (line: string): Promise<void> => {
		await input.log?.(line).catch(() => {})
	}
	const checkpoint = recordedCheckpoint(attempt, input)
	if (checkpoint === null) {
		await log('unrecognised checkpoint; failing without platform calls')
		return { state: 'failed' }
	}
	if (!attempt.submitted(checkpoint)) {
		// A throw keeps the run running; the next maintenance pass discards again.
		await attempt.discard(checkpoint, signal)
		await log(
			`deploy interrupted: Control stopped before it ${words.submission}; ${words.discarded} ${words.candidate(checkpoint)}; run the deploy again`,
		)
		return { state: 'failed' }
	}
	const observed = await attempt.observe(checkpoint, signal)
	if (observed.state === 'unobservable') {
		signal.throwIfAborted()
		if (!pastDeadline(attempt, input.startedAtMs)) return { state: 'running' }
		await stopQuietly(attempt, checkpoint, signal)
		await log(`abandoned ${words.candidate(checkpoint)}: its status stayed unobservable past the run deadline`)
		return { state: 'failed' }
	}
	if (observed.state === 'active') return { state: 'succeeded' }
	if (observed.state !== 'pending') return { state: 'failed' }
	if (pastDeadline(attempt, input.startedAtMs)) {
		await stopQuietly(attempt, checkpoint, signal)
		await log(`abandoned non-terminal ${words.candidate(checkpoint)} (${observed.status ?? 'unknown'})`)
		return { state: 'failed' }
	}
	return { state: 'running' }
}
