// Through the console gateway only a signed-in session administers IAM: a console token the proxy minted from a `px_`
// key carries no `session` mark, because the key's own grants narrow what it carries (ADR-0022).

import { IAM_APP_ID } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { generateToken, hashToken } from '../secret'
import { mintFromKey } from '../tokens'
import { bearerRpc, consoleRpc } from './helpers/app-people'
import { CONSOLE_APP, createHarness, TEST_SIGNING_ENV } from './helpers/harness'
import { type MembershipFixture, membershipFixture } from './helpers/membership'

const CONSOLE_SCHEMA = { scopes: [], actions: [{ action: 'deploy.read' }, { action: 'deploy.trigger' }], roles: {} }

async function installationAdmin(): Promise<{ f: MembershipFixture; adminId: string }> {
	const { repositories } = createHarness()
	const f = await membershipFixture(repositories)
	expect((await f.putSchema(CONSOLE_SCHEMA, CONSOLE_APP)).status).toBe(200)
	const admin = await repositories.principals.createUser('sub-admin', 'admin@example.test')
	await repositories.grants.createGrant({ principalId: admin.id, roleKey: 'admin' })
	return { f, adminId: admin.id }
}

async function issueKey(f: MembershipFixture, principalId: string, app: string, action: string): Promise<string> {
	const key = `px_${generateToken()}`
	await f.repositories.credentials.createCredential({
		tokenHash: await hashToken(key),
		label: action,
		principalId,
		app,
		issuedBy: principalId,
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
		grants: [{ action, scopeType: null, scopeValue: null }],
	})
	return key
}

describe('administering IAM through the console gateway', () => {
	test('a console token minted from a key narrowed to one console action administers nothing', async () => {
		const { f, adminId } = await installationAdmin()
		const key = await issueKey(f, adminId, CONSOLE_APP, 'deploy.read')
		const { result } = await mintFromKey(f.services, TEST_SIGNING_ENV, { app: CONSOLE_APP, key, requestId: 'r1' })
		if (!result.ok) throw new Error(`mintFromKey refused: ${result.reason}`)

		expect((await bearerRpc(f, result.token, 'principals.list', {})).status).toBe(403)
		expect((await bearerRpc(f, result.token, 'apiKeys.provision', { label: 'escalated', type: 'service', roleKey: 'admin' })).status).toBe(403)
	})

	test('the same administrator signed in administers IAM', async () => {
		const { f, adminId } = await installationAdmin()

		expect((await consoleRpc(f, adminId, 'principals.list', {})).status).toBe(200)
		expect((await consoleRpc(f, adminId, 'apiKeys.provision', { label: 'ci', type: 'service', roleKey: 'admin' })).status).toBe(200)
	})

	test('a key bound to IAM itself still administers IAM directly', async () => {
		const { f, adminId } = await installationAdmin()
		const key = await issueKey(f, adminId, IAM_APP_ID, 'iam.admin')

		expect((await bearerRpc(f, key, 'principals.list', {})).status).toBe(200)
	})
})
