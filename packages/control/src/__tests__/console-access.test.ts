import type { AuthContext } from '@fabrika/auth'
import type { ConsoleAccessDto } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { consoleAccess } from '../console-access'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { authWithActions, authWithPermissions } from './helpers/iam'
import { fakeControlProvider } from './helpers/provider'
import { rpcRequest, rpcResult } from './helpers/rpc'

const consoleAccessSchema = z.object({
	principal: z.object({ id: z.string(), label: z.string() }).strict().nullable(),
	global: z.array(z.string()),
	scopes: z.array(z.object({ type: z.string(), value: z.string(), actions: z.array(z.string()) }).strict()),
}).strict()

function deps(auth: AuthContext): ControlRpcDeps {
	return {
		repositories: createHarness().db,
		auth,
		queue: { send: () => Promise.resolve() },
		logs: { get: () => Promise.resolve(null) },
		provider: fakeControlProvider,
		cancelRun: () => Promise.resolve(),
	}
}

async function read(auth: AuthContext): Promise<ConsoleAccessDto> {
	const response = await rpcResult(rpcRequest('consoleAccess'), deps(auth))
	expect(response.status).toBe(200)
	return consoleAccessSchema.parse(await response.json())
}

describe('consoleAccess', () => {
	test('a caller with no grant reads in, holding nothing', async () => {
		expect(await read(authWithActions([], 'nobody@test'))).toEqual({
			principal: { id: 'p-nobody@test', label: 'nobody@test' },
			global: [],
			scopes: [],
		})
	})

	test('a pattern grant is listed as the console actions it covers', async () => {
		const access = await read(authWithActions(['deploy.*', 'operations.read']))
		expect(access.global).toEqual(['deploy.trigger', 'deploy.read', 'operations.read'])
		expect(access.scopes).toEqual([])
	})

	test('a scoped grant is listed under its scope value, by dimension and then value', async () => {
		const access = await read(authWithPermissions([
			{ action: 'operations.read', scope: { type: 'environment', value: 'prod' } },
			{ action: 'operations.*', scope: { type: 'app', value: 'notes' } },
			{ action: 'deploy.read', scope: { type: 'app', value: 'blog' } },
		]))
		expect(access.global).toEqual([])
		expect(access.scopes).toEqual([
			{ type: 'app', value: 'blog', actions: ['deploy.read'] },
			{ type: 'app', value: 'notes', actions: ['operations.read', 'operations.triage', 'operations.manage'] },
			{ type: 'environment', value: 'prod', actions: ['operations.read'] },
		])
	})

	test('a global grant is not repeated under a scope value', async () => {
		const access = await read(authWithPermissions([
			{ action: 'operations.read', scope: null },
			{ action: 'operations.read', scope: { type: 'app', value: 'notes' } },
			{ action: 'operations.triage', scope: { type: 'app', value: 'notes' } },
		]))
		expect(access.global).toEqual(['operations.read'])
		expect(access.scopes).toEqual([{ type: 'app', value: 'notes', actions: ['operations.triage'] }])
	})

	test('an action outside the console vocabulary is not listed', async () => {
		expect((await read(authWithActions(['iam.admin', 'notes.read']))).global).toEqual([])
	})

	test('the bootstrap admin, whose can() allows everything, holds every console action globally', () => {
		const bootstrap: AuthContext = { ...authWithActions([], 'root@test'), can: () => true, scopedTo: () => [] }
		const access = consoleAccess(bootstrap)
		expect(access.global).toContain('access.approve')
		expect(access.global).toContain('operations.manage')
		expect(access.scopes).toEqual([])
	})

	test('a credential bound to no principal reads in with no principal', () => {
		expect(consoleAccess({ ...authWithActions(['deploy.read']), principal: null }).principal).toBeNull()
	})
})
