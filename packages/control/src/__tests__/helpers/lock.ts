import type { DeployLockGate } from '../../run-lifecycle'

/**
 * In-memory stand-in for the deploy lock, mirroring its contract for the run-lifecycle tests:
 * non-reentrant acquire (a held key returns false) + holder-checked release. `held` is exposed so tests
 * can assert the lock was released (empty) or pre-seed contention. No TTL — the tests exercise the
 * contention/release behavior; lease expiry is covered against the real table in deploy-locks.test.ts.
 */
export function makeFakeLock(): DeployLockGate & { held: Map<string, string> } {
	const held = new Map<string, string>()
	return {
		held,
		acquire(key, holder) {
			if (held.has(key)) {
				return Promise.resolve(false)
			}
			held.set(key, holder)
			return Promise.resolve(true)
		},
		release(key, holder) {
			if (held.get(key) === holder) {
				held.delete(key)
			}
			return Promise.resolve()
		},
	}
}
