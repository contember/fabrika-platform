/**
 * Each composition root picks the PBKDF2 cost its runtime can derive. Production Cloudflare Workers refuse PBKDF2 above
 * 100,000 iterations with `NotSupportedError`; workerd, miniflare and Bun do not, so only these assertions on what each
 * root actually builds can catch a Worker hasher that asks for more.
 */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { RequestContext } from '../env'
import { createRuntime } from '../node/runtime'
import { type PasswordHasher, PBKDF2_SHA256_ALGORITHM } from '../password-crypto'
import { buildServices } from '../services'

mock.module('cloudflare:workers', () => ({
	WorkerEntrypoint: class<E> {
		constructor(public readonly ctx: RequestContext, public readonly env: E) {}
	},
	DurableObject: class<E> {
		constructor(public readonly ctx: unknown, public readonly env: E) {}
	},
}))

const { iamEnv } = await import('../index')

const WORKERS_PBKDF2_ITERATION_CAP = 100_000
const PASSWORD = 'a perfectly reasonable long password'

/** `iamEnv` only hands the binding to the repositories, which this suite never queries. */
class UnusedD1 implements D1Database {
	prepare(): D1PreparedStatement {
		throw new Error('the composition test never queries D1')
	}
	batch<T = unknown>(): Promise<D1Result<T>[]> {
		throw new Error('the composition test never queries D1')
	}
	exec(): Promise<D1ExecResult> {
		throw new Error('the composition test never queries D1')
	}
	dump(): Promise<ArrayBuffer> {
		throw new Error('the composition test never queries D1')
	}
	withSession(): D1DatabaseSession {
		throw new Error('the composition test never queries D1')
	}
}

function workerHasher(): PasswordHasher {
	return buildServices(iamEnv({
		DB: new UnusedD1(),
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'local',
		ISSUER: 'http://localhost:18191',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
	})).passwordHasher
}

async function withBunHasher<T>(run: (hasher: PasswordHasher) => Promise<T>): Promise<T> {
	const runtime = await createRuntime({
		ENVIRONMENT: 'local',
		ISSUER: 'http://localhost:18191',
		FABRIKA_IAM_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:1/iam',
		FABRIKA_IAM_OIDC_ENABLED: 'false',
		FABRIKA_IAM_PASSWORD_ENABLED: 'true',
	})
	try {
		return await run(buildServices(runtime.env).passwordHasher)
	} finally {
		await runtime.shutdown()
	}
}

function iterationsOf(parameters: string): unknown {
	const parsed: unknown = JSON.parse(parameters)
	return typeof parsed === 'object' && parsed !== null && 'iterations' in parsed ? parsed.iterations : undefined
}

afterEach(() => {
	mock.restore()
})

describe('the PBKDF2 cost each composition root chooses', () => {
	test('the Worker hashes within the Cloudflare Workers iteration cap', async () => {
		const stored = await workerHasher().hash(PASSWORD)

		const iterations = iterationsOf(stored.parameters)
		expect(typeof iterations).toBe('number')
		expect(Number(iterations)).toBeLessThanOrEqual(WORKERS_PBKDF2_ITERATION_CAP)
		expect(await workerHasher().verify(PASSWORD, stored)).toEqual({ valid: true, needsRehash: false })
	})

	test('the Bun process hashes with 600,000 iterations', async () => {
		const stored = await withBunHasher((hasher) => hasher.hash(PASSWORD))

		expect(iterationsOf(stored.parameters)).toBe(600_000)
	})

	test('the Worker refuses a stored hash above its cap without deriving at the stored count', async () => {
		const stored = await withBunHasher((hasher) => hasher.hash(PASSWORD))
		const hasher = workerHasher()
		const deriveBits = spyOn(crypto.subtle, 'deriveBits')

		expect(await hasher.verify(PASSWORD, stored)).toEqual({ valid: false, needsRehash: false })
		const derivedIterations = deriveBits.mock.calls.map((
			[algorithm],
		) => (typeof algorithm === 'object' && 'iterations' in algorithm ? algorithm.iterations : undefined))
		expect(derivedIterations).toHaveLength(1)
		expect(Number(derivedIterations[0])).toBeLessThanOrEqual(WORKERS_PBKDF2_ITERATION_CAP)
	})

	test('the Worker still verifies and upgrades a stored hash below its cap', async () => {
		const hasher = workerHasher()
		const stored = await hasher.hash(PASSWORD)
		const weaker = { ...stored, parameters: JSON.stringify({ iterations: 1_000, outputBytes: 32 }) }
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, ['deriveBits'])
		const salt = Uint8Array.from(stored.salt.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
		const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1_000 }, key, 256))
		const passwordHash = [...bits].map((byte) => byte.toString(16).padStart(2, '0')).join('')

		expect(stored.algorithm).toBe(PBKDF2_SHA256_ALGORITHM)
		expect(await hasher.verify(PASSWORD, { ...weaker, passwordHash })).toEqual({ valid: true, needsRehash: true })
	})
})
