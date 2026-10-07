import type { DeployLocks } from '@fabrika/platform'
import { abortableWait, ProviderInvocationAbort } from '@fabrika/provider-contract'
import type { ControlRegistryRepository, DeploymentNamespaceRow, DeploymentNamespaceState } from './db'
import { LEASE_TTL_MS } from './lease'
import { uuidv7 } from './uuid'

export interface OwnershipTiming {
	now(): number
	wait(ms: number, signal: AbortSignal): Promise<void>
	ttlMs: number
	pollMs: number
}

export const namespaceLockKey = (namespaceId: string): string => `namespace:${namespaceId}`

const defaultTiming: OwnershipTiming = { now: Date.now, wait: abortableWait, ttlMs: LEASE_TTL_MS, pollMs: 1000 }
export type NamespaceOwnershipRepository = Pick<ControlRegistryRepository, 'getDeploymentNamespace' | 'checkpointDeploymentNamespace'>

export class NamespaceOwnership {
	private readonly controller = new AbortController()
	private readonly stop = new AbortController()
	private readonly heartbeat: Promise<void>
	private tail: Promise<void> = Promise.resolve()
	private deadline: number
	private current: DeploymentNamespaceRow

	private constructor(
		row: DeploymentNamespaceRow,
		private readonly registry: NamespaceOwnershipRepository,
		private readonly lock: DeployLocks,
		private readonly holder: string,
		private readonly timing: OwnershipTiming,
		acquiredAt: number,
	) {
		this.current = row
		this.deadline = acquiredAt + timing.ttlMs
		this.heartbeat = this.renewLoop()
	}

	static async acquire(
		registry: NamespaceOwnershipRepository,
		lock: DeployLocks,
		namespaceId: string,
		timing = defaultTiming,
	): Promise<NamespaceOwnership | null> {
		const holder = uuidv7()
		const acquiredAt = timing.now()
		if (!(await lock.acquire(namespaceLockKey(namespaceId), holder, timing.ttlMs))) return null
		try {
			const row = await registry.getDeploymentNamespace(namespaceId)
			if (row === null) throw new Error(`deployment namespace ${namespaceId} not found`)
			return new NamespaceOwnership(row, registry, lock, holder, timing, acquiredAt)
		} catch (cause) {
			await lock.release(namespaceLockKey(namespaceId), holder)
			throw cause
		}
	}

	get row(): DeploymentNamespaceRow {
		return this.current
	}
	get signal(): AbortSignal {
		return this.controller.signal
	}
	assertOwned(): void {
		if (this.timing.now() >= this.deadline) this.invalidate()
		this.signal.throwIfAborted()
	}
	private invalidate(): void {
		const reason = new ProviderInvocationAbort('lease_lost')
		this.controller.abort(reason)
		this.stop.abort(reason)
	}

	private async renewLoop(): Promise<void> {
		try {
			while (!this.stop.signal.aborted) {
				await this.timing.wait(this.timing.ttlMs / 3, this.stop.signal)
				this.assertOwned()
				const started = this.timing.now()
				const timeout = new AbortController()
				let renewed: boolean
				try {
					renewed = await Promise.race([
						this.lock.renew(namespaceLockKey(this.current.id), this.holder, this.timing.ttlMs),
						this.timing.wait(Math.max(0, this.deadline - started), AbortSignal.any([this.stop.signal, timeout.signal])).then(() => false),
					])
				} finally {
					timeout.abort()
				}
				this.assertOwned()
				if (!renewed) {
					this.invalidate()
					return
				}
				this.deadline = started + this.timing.ttlMs
			}
		} catch {
			if (!this.stop.signal.aborted) this.invalidate()
		}
	}

	checkpoint(providerTargetJson: string, state: DeploymentNamespaceState = this.current.state, lastError: string | null = null): Promise<void> {
		const result = this.tail.then(async () => {
			this.assertOwned()
			try {
				const row = await this.registry.checkpointDeploymentNamespace({
					expected: this.current,
					holder: this.holder,
					nowMs: this.timing.now(),
					providerTargetJson,
					state,
					lastError,
				})
				if (row === null) throw new ProviderInvocationAbort('lease_lost')
				this.current = row
				this.assertOwned()
			} catch (cause) {
				this.invalidate()
				throw cause
			}
		})
		this.tail = result
		void result.catch(() => {})
		return result
	}

	async close(): Promise<void> {
		this.invalidate()
		await this.tail.catch(() => {})
		await this.heartbeat
		await this.lock.release(namespaceLockKey(this.current.id), this.holder)
	}
}
