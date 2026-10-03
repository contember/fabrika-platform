import { SqlDeployLocks } from '@fabrika/platform'
import type { ControlRepositories } from '../../db'
import type { DeployLockGate } from '../../run-lifecycle'
import { harnessDatabase } from './harness'

/** Run and namespace tests that checkpoint require repositories for real SQL fencing. */
export function makeFakeLock(repositories?: ControlRepositories): DeployLockGate & { held: Map<string, string> } {
	const held = new Map<string, string>()
	const sql = repositories === undefined ? undefined : new SqlDeployLocks(harnessDatabase(repositories))
	return {
		held,
		async acquire(key, holder) {
			if (held.has(key)) {
				return Promise.resolve(false)
			}
			if (sql !== undefined && !(await sql.acquire(key, holder, 30 * 60 * 1000))) return false
			held.set(key, holder)
			return Promise.resolve(true)
		},
		renew: (key, holder) => sql === undefined ? Promise.resolve(held.get(key) === holder) : sql.renew(key, holder, 30 * 60 * 1000),
		async release(key, holder) {
			await sql?.release(key, holder)
			if (held.get(key) === holder) {
				held.delete(key)
			}
			return Promise.resolve()
		},
	}
}
