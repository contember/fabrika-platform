import { type JsonValue, ProviderInvocationAbort } from '@fabrika/provider-contract'
import { type RunMutationGuard, type RunRepository, type RunRow, serializeProviderJson } from './db/runs'
import { uuidv7 } from './uuid'

export const DEPLOY_LEASE_TTL_MS = 90 * 1000

export interface DeployLockGate {
	acquire(key: string, holder: string): Promise<boolean>
	renew(key: string, holder: string): Promise<boolean>
	release(key: string, holder: string): Promise<void>
}

export interface OwnershipTiming {
	now(): number
	wait(ms: number, signal: AbortSignal): Promise<void>
	ttlMs: number
	pollMs: number
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		signal.throwIfAborted()
		const abort = (): void => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort)
			resolve()
		}, ms)
		signal.addEventListener('abort', abort, { once: true })
	})

const defaultTiming: OwnershipTiming = { now: Date.now, wait, ttlMs: DEPLOY_LEASE_TTL_MS, pollMs: 1000 }

export class RunOwnership {
	readonly ownership = new AbortController()
	readonly work = new AbortController()
	private readonly stop = new AbortController()
	private tail: Promise<void> = Promise.resolve()
	private readonly heartbeat: Promise<void>
	private deadline: number
	private expected: string | null
	private accepted: boolean

	private constructor(
		readonly row: RunRow,
		private readonly runs: RunRepository,
		private readonly lock: DeployLockGate,
		private readonly key: string,
		private readonly holder: string,
		private readonly timing: OwnershipTiming,
		acquiredAt: number,
	) {
		this.expected = row.provider_state_json
		this.accepted = row.external_run_id !== null
		this.deadline = acquiredAt + timing.ttlMs
		this.heartbeat = Promise.all([this.renewLoop(), this.observeLoop()]).then(() => {})
		if (row.cancel_requested_at !== null) this.work.abort(new ProviderInvocationAbort('cancel_requested'))
	}

	static async acquire(runs: RunRepository, lock: DeployLockGate, candidate: RunRow, timing = defaultTiming): Promise<RunOwnership | null> {
		const holder = uuidv7()
		const key = `${candidate.app_id}:${candidate.env}`
		const acquiredAt = timing.now()
		if (!(await lock.acquire(key, holder))) return null
		try {
			const row = await runs.getRun(candidate.id)
			if (row === null) {
				await lock.release(key, holder)
				return null
			}
			return new RunOwnership(row, runs, lock, key, holder, timing, acquiredAt)
		} catch (error) {
			await lock.release(key, holder)
			throw error
		}
	}

	get hasAccepted(): boolean {
		return this.accepted
	}
	get lost(): boolean {
		if (this.timing.now() >= this.deadline) this.invalidate()
		return this.ownership.signal.aborted
	}

	invalidate(): void {
		const reason = new ProviderInvocationAbort('lease_lost')
		this.ownership.abort(reason)
		this.work.abort(reason)
		this.stop.abort(reason)
	}

	guard(): RunMutationGuard {
		if (this.lost) throw new ProviderInvocationAbort('lease_lost')
		return { holder: this.holder, nowMs: this.timing.now(), expectedProviderStateJson: this.expected }
	}

	async refreshCancellation(): Promise<RunRow | null> {
		this.guard()
		const timeout = new AbortController()
		let row: RunRow | null
		try {
			row = await Promise.race([
				this.runs.getRun(this.row.id),
				this.timing.wait(Math.max(0, this.deadline - this.timing.now()), AbortSignal.any([this.stop.signal, timeout.signal])).then(() => {
					this.invalidate()
					throw new ProviderInvocationAbort('lease_lost')
				}),
			])
		} finally {
			timeout.abort()
		}
		this.guard()
		if (row?.cancel_requested_at !== null && row?.cancel_requested_at !== undefined) {
			this.work.abort(new ProviderInvocationAbort('cancel_requested'))
		}
		return row
	}

	private async renewLoop(): Promise<void> {
		try {
			while (!this.stop.signal.aborted) {
				await this.timing.wait(this.timing.ttlMs / 3, this.stop.signal)
				this.guard()
				const started = this.timing.now()
				const timeout = new AbortController()
				let renewed: boolean
				try {
					renewed = await Promise.race([
						this.lock.renew(this.key, this.holder),
						this.timing.wait(Math.max(0, this.deadline - started), AbortSignal.any([this.stop.signal, timeout.signal])).then(() => false),
					])
				} finally {
					timeout.abort()
				}
				if (!renewed || this.lost) {
					this.invalidate()
					return
				}
				this.deadline = started + this.timing.ttlMs
			}
		} catch {
			if (!this.stop.signal.aborted) this.invalidate()
		}
	}

	private async observeLoop(): Promise<void> {
		try {
			while (!this.stop.signal.aborted) {
				await this.timing.wait(Math.min(this.timing.pollMs, Math.max(0, this.deadline - this.timing.now())), this.stop.signal)
				await this.refreshCancellation()
			}
		} catch {
			if (!this.stop.signal.aborted) this.invalidate()
		}
	}

	mutate(write: (guard: RunMutationGuard) => Promise<boolean>, nextState?: JsonValue, acceptance = false, after?: () => Promise<void>): Promise<void> {
		const result = this.tail.then(async () => {
			const serialized = nextState === undefined ? this.expected : serializeProviderJson(nextState)
			let persisted: boolean
			try {
				persisted = await write(this.guard())
			} catch (error) {
				this.invalidate()
				throw error
			}
			if (!persisted) {
				this.invalidate()
				throw new ProviderInvocationAbort('lease_lost')
			}
			this.expected = serialized
			if (acceptance) this.accepted = true
			await after?.()
		})
		this.tail = result
		void result.catch(() => {})
		return result
	}

	drain(): Promise<void> {
		return this.tail
	}

	async close(): Promise<void> {
		this.invalidate()
		await this.tail.catch(() => {})
		await this.heartbeat
		await this.lock.release(this.key, this.holder)
	}
}
