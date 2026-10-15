/**
 * Backlog 57 on the Bun root (`src/node/server.ts`): the Caddy proxy deletes a caller's `X-Request-Id`
 * and injects its own, so IAM keeps a well-formed one. A malformed one still never reaches `auth_log`.
 * The Worker root's half is in index.test.ts, next to its `cloudflare:workers` mock.
 */

import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import type { Env, RequestContext } from '../env'
import { createFetchHandler } from '../node/server'
import { createHarness, type Harness } from './helpers/harness'

const ISSUER = 'https://iam.example.test'
const GENERATED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CALLER_RAY = '8f1c2a3b4c5d6e7f-PRG'

class TestContext implements RequestContext {
	readonly pending: Promise<unknown>[] = []
	readonly waitUntil = (promise: Promise<unknown>): void => {
		this.pending.push(promise)
	}
}

function env(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
	}
}

/** A refused password login: it writes one `auth_log` row carrying the request's correlation id. */
async function failedLoginRequestId(requestIdHeader: string): Promise<string | undefined> {
	const h = createHarness()
	const ctx = new TestContext()
	const handler = createFetchHandler({
		env: env(h),
		ctx,
		config: { port: 0, rpcKey: '', proxyKey: '' },
		shutdown: () => Promise.resolve(),
	})
	const response = await handler(
		new Request(`${ISSUER}/auth/login`, {
			method: 'POST',
			headers: {
				Origin: ISSUER,
				'Sec-Fetch-Site': 'same-origin',
				'Content-Type': 'application/x-www-form-urlencoded',
				'X-Request-Id': requestIdHeader,
				'cf-ray': CALLER_RAY,
			},
			body: new URLSearchParams({ email: 'nobody@example.test', password: 'a wrong but long password' }),
		}),
	)
	await Promise.all(ctx.pending)

	expect(response.status).toBe(401)
	const rows = h.sqlite.query<{ request_id: string }, []>('SELECT request_id FROM auth_log').all()
	expect(rows).toHaveLength(1)
	return rows[0]?.request_id
}

describe('the Bun root chooses the audit correlation id', () => {
	test('keeps a well-formed proxy id', async () => {
		const proxyId = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'

		expect(await failedLoginRequestId(proxyId)).toBe(proxyId)
	})

	test('replaces an overlong id with a generated one, not a truncated one', async () => {
		const overlong = 'a'.repeat(4096)
		const stored = await failedLoginRequestId(overlong)

		expect(stored).toMatch(GENERATED)
	})

	test('replaces an id with disallowed characters, and does not fall back to cf-ray', async () => {
		const stored = await failedLoginRequestId('forged id; drop')

		expect(stored).toMatch(GENERATED)
		expect(stored).not.toBe(CALLER_RAY)
	})
})
