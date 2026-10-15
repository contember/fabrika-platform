import { SQL } from 'bun'

/**
 * SQLSTATE 53300 (`too_many_connections`): no slot the role may take is free, whether the server's, the database's or
 * the role's limit is reached. It refuses a connection and never a statement on one that is open.
 */
export const TOO_MANY_CONNECTIONS = '53300'

/** How every report of an exhausted connection limit starts, so a caller that reads only output can recognise one. */
export const CONNECTION_CAPACITY_MESSAGE = 'the database had no free connection slot'

/** How long a caller waits for a free connection slot by default before it gives up. */
export const DEFAULT_CONNECTION_WAIT_MS = 60_000

const FIRST_DELAY_MS = 250
const MAX_DELAY_MS = 5_000

/** Whether `error` is the server refusing a connection because every slot it may take is in use. */
export function isConnectionCapacityError(error: unknown): boolean {
	return error instanceof SQL.PostgresError && error.errno === TOO_MANY_CONNECTIONS
}

/** The database kept refusing connections for lack of a free slot until the wait ran out. */
export class ConnectionCapacityError extends Error {
	constructor(readonly waitedMs: number) {
		super(`${CONNECTION_CAPACITY_MESSAGE} for ${Math.round(waitedMs / 1000)} s (SQLSTATE ${TOO_MANY_CONNECTIONS}): its connection limit is exhausted`)
		this.name = 'ConnectionCapacityError'
	}
}

export interface ConnectionCapacityWait {
	/** How long to keep retrying; `DEFAULT_CONNECTION_WAIT_MS` by default. */
	readonly waitMs?: number
	readonly sleep?: (ms: number) => Promise<void>
	readonly now?: () => number
	readonly random?: () => number
}

/**
 * Runs `attempt` until it does not fail for lack of a connection slot, waiting with jittered exponential backoff between
 * tries, and throws `ConnectionCapacityError` once `waitMs` has passed. Any other failure is thrown at once. `attempt`
 * must release whatever it opened before it throws, so that a waiting caller holds no slot another needs.
 */
export async function withConnectionCapacity<T>(attempt: () => Promise<T>, options: ConnectionCapacityWait = {}): Promise<T> {
	const waitMs = options.waitMs ?? DEFAULT_CONNECTION_WAIT_MS
	const sleep = options.sleep ?? Bun.sleep
	const now = options.now ?? Date.now
	const random = options.random ?? Math.random
	const started = now()
	for (let tries = 0;; tries++) {
		try {
			return await attempt()
		} catch (error) {
			if (!isConnectionCapacityError(error)) throw error
			const left = started + waitMs - now()
			if (left <= 0) throw new ConnectionCapacityError(now() - started)
			// Jittered, so the containers of one deploy that were refused together do not retry together.
			const delay = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** tries) * (0.5 + random() / 2)
			await sleep(Math.min(left, delay))
		}
	}
}
