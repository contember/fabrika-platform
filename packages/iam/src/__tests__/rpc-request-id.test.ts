/**
 * Backlog 57 at the `IamRpc` boundary: an app passes `requestId` in the call itself, so no ingress
 * header rule applies to it. `createIamRpc` holds it to the same length cap and allowlist, and replaces
 * a failing value with a generated one rather than refusing the call.
 */

import type { AuditInput } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import type { Env, RequestContext } from '../env'
import { createIamRpc } from '../rpc'
import { handleRpcHttp } from '../rpc-http'
import { createHarness, type Harness } from './helpers/harness'

const RPC_KEY = 'rpc-test-key-0123456789abcdefghij'
const GENERATED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

class TestContext implements RequestContext {
	readonly pending: Promise<unknown>[] = []
	readonly waitUntil = (promise: Promise<unknown>): void => {
		this.pending.push(promise)
	}
	async drain(): Promise<void> {
		await Promise.all(this.pending)
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
		EMAIL_PROVIDER: 'none',
		ISSUER: 'https://iam.example.test',
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
	}
}

function auditEvent(requestId: string): AuditInput {
	return { app: 'reports', requestId, principalId: null, principalLabel: 'share link', action: 'report.view', resourceType: 'report' }
}

function requestIds(h: Harness, table: 'audit_events' | 'auth_log'): string[] {
	return h.sqlite.query<{ request_id: string }, []>(`SELECT request_id FROM ${table}`).all().map((row) => row.request_id)
}

async function auditedRequestId(requestId: string): Promise<string | undefined> {
	const h = createHarness()
	const ctx = new TestContext()
	await createIamRpc(env(h), ctx).audit(auditEvent(requestId))
	await ctx.drain()
	const ids = requestIds(h, 'audit_events')
	expect(ids).toHaveLength(1)
	return ids[0]
}

describe('the IamRpc boundary holds requestId to the audit rule', () => {
	test('keeps a well-formed id', async () => {
		expect(await auditedRequestId('0192f3a4-5b6c-7d8e-9f01-23456789abcd')).toBe('0192f3a4-5b6c-7d8e-9f01-23456789abcd')
	})

	test('replaces an overlong id with a generated one, and still writes the event', async () => {
		expect(await auditedRequestId('a'.repeat(4096))).toMatch(GENERATED)
	})

	test('replaces an id with disallowed characters', async () => {
		expect(await auditedRequestId('forged id\nnext line')).toMatch(GENERATED)
	})

	test('applies to the auth_log rows the mint fronts write', async () => {
		const h = createHarness()
		const ctx = new TestContext()
		const result = await createIamRpc(env(h), ctx).mintFromKey({ app: 'reports', key: 'px_does-not-exist', requestId: 'x'.repeat(500) })
		await ctx.drain()

		expect(result.ok).toBe(false)
		const ids = requestIds(h, 'auth_log')
		expect(ids).toHaveLength(1)
		expect(ids[0]).toMatch(GENERATED)
	})

	test('applies over the HTTP transport, which dispatches onto the same object', async () => {
		const h = createHarness()
		const ctx = new TestContext()
		const request = new Request('https://iam.example.test/rpc/audit', {
			method: 'POST',
			headers: { 'content-type': 'application/json', Authorization: `Bearer ${RPC_KEY}` },
			body: JSON.stringify(auditEvent('forged;id')),
		})

		const response = await handleRpcHttp(request, createIamRpc(env(h), ctx), RPC_KEY)
		await ctx.drain()

		expect(response.status).toBe(204)
		const ids = requestIds(h, 'audit_events')
		expect(ids).toHaveLength(1)
		expect(ids[0]).toMatch(GENERATED)
	})
})
